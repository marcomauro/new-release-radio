# Architecture

Three layers, one rule: **each one only knows the layer below it, through a
narrow interface.** That is what lets the rules change without touching the
player, and the player change without touching the rules.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ ui/            Cover · Controls · Panel                              │
 │                knows: the engine's state object                      │
 └───────────────────────────────▲──────────────────────────────────────┘
                                 │  { current, why, upNext, cover, … }
 ┌───────────────────────────────┴──────────────────────────────────────┐
 │ radio/useRadio.js   the engine                                       │
 │   • owns the station and the selected provider                       │
 │   • branches ONLY on provider capabilities, never on provider id     │
 └───────────▲──────────────────────────────────────▲──────────────────┘
             │ station API                          │ provider contract
 ┌───────────┴───────────────────┐   ┌──────────────┴──────────────────┐
 │ core/                          │   │ providers/                      │
 │   graph.js   archive + index    │   │   spotify/connect  (full+queue) │
 │   rules.js   constraints/scorers│   │   spotify/embed    (preview)    │
 │   walker.js  the endless walk   │   │   simulated        (silent)     │
 │                                 │   │                                 │
 │  pure, synchronous, testable in  │   │  async, all failures contained  │
 │  Node — no DOM, no network       │   │  and reported via poll()        │
 └─────────────────────────────────┘   └─────────────────────────────────┘
```

## Why the walk is pure

`core/` has no `fetch`, no DOM and no clock. A step is a function of
`(state, index, ruleset, seed)`, and the RNG is derived from
`(seed, step number)` rather than kept as a stream. Three things follow:

1. **The lookahead is free.** Peeking two tracks ahead and then committing them
   one at a time can never disagree with itself, so the "next" shown in the
   footer is exactly what will play — and, on Spotify Connect, exactly what has
   already been handed to the platform's queue.
2. **A walk is reproducible.** `(archive, seed, preset)` fully determines the
   sequence, which is what makes `scripts/walk.mjs` a real tuning tool and a
   station shareable as a URL.
3. **Rules are testable in the terminal.** No browser, no account, 0.5 ms per
   step over 873 tracks.

State is copied per step (a few Maps of ≤873 entries). Measured cost of 400
steps: ~200 ms total, so the copies are not worth optimising away.

## Why the engine branches on capabilities

`useRadio` never asks *which* provider it has; it asks what the provider can do:

| capability | strategy |
| --- | --- |
| `CAPS.QUEUE` | start once, then append each decided track. The platform owns continuity; `poll()` is the source of truth for what is on air. |
| no `CAPS.QUEUE` | advance the walk ourselves on `endedRef`, then `start()` the next track. |

This is the seam that keeps a future platform cheap. It also produces the
self-healing behaviour on Connect: whatever `poll()` reports becomes the cursor.
If the user starts a track by hand, the walk **follows** — and if that track is
in the archive, the walk continues from it, which is exactly what a listener
means by "play something like this".

The one visible consequence: after changing the ruleset, the track already handed
to the platform's queue still plays (one track of lag) and the walk re-decides
from there. The alternative — clearing the platform queue — means restarting
playback, which is worse.

## Where each concern lives

| question | file |
| --- | --- |
| What is in the archive? | `core/graph.js` |
| What plays next, and why? | `core/rules.js` (see `docs/RULES.md`) |
| How is the walk carried out? | `core/walker.js` |
| How is it heard? | `providers/*` (see `docs/PROVIDERS.md`) |
| When does the next track start? | `radio/useRadio.js` |
| What does it look like? | `ui/*`, `index.css`, `theme.js` |

## The phone is a different machine

Not a smaller screen — a different set of rules:

| what changes | consequence |
| --- | --- |
| timers freeze when the app leaves the screen | the platform queue is filled to cover ten minutes of music while `document.hidden`, and the walk fast-forwards on return (`useRadio.js`, `targetDepth`) |
| the network comes and goes | the next section — the hardest case in the whole app |
| a cross-origin iframe wants the tap inside itself | previews are the declared fallback on touch; Connect is offered first |
| fingers, not pointers | 34 px minimum on anything tappable, under `@media (hover: none)` |
| `100%` height measures the large viewport | `100dvh`, with `100%` as the fallback |
| a square that must fit two dimensions | the cover is the largest square that fits the space **left over**: `.cover-slot` is a size container and the cover is `min(--cover, 100cqw, 100cqh)`. Sized from the viewport it could not shrink, and on a short window it overflowed upward onto the pills |
| landscape is wide and short | the stage becomes a two-column grid: cover left, everything else right |

## A network that answers sometimes

The hard case is not a network that is down — it is one that drops one request in
five. The whole design rests on one distinction:

> **A refusal changes what is true. A lost request only changes what we know.**

Collapsing the two is what produced the worst bug this app has had. A dropped
request threw the browser's raw `TypeError`, the provider turned that into an
empty snapshot, and the engine wrote it into state — so the screen said nothing
was playing while Spotify played on, and the obvious next tap sent a `play` that
restarted the track and threw away the queue.

Where the distinction lives now:

| layer | what it does |
| --- | --- |
| `providers/spotify/api.js` | one error shape, `{ kind: 'network' \| 'http' \| 'auth' }`; a deadline on every request (a stalled mobile connection hangs rather than failing); retries chosen per verb — reads freely, `queue` and `volume` once because the result is reconciled, `play`/`next`/`resume`/`seek` never, because a duplicate is audible |
| `providers/spotify/auth.js` | `acquireToken()` answers `token` / `network` / `rejected`. Only a rejection ends the session — a blip during the one minute an hour when a refresh is due used to be reported as "session expired" |
| `providers/spotify/connect.js` | a lost request returns `staleSnapshot()`, never `playing: false`; the notice is classified so transient kinds clear themselves; a network failure never marks a device as refusing volume |
| `radio/useRadio.js` | a stale snapshot is merged onto the last known state, position carried on the local clock (clamped at 45 s, then frozen); the link has a state that sets the poll cadence; the queue is topped up **during** an outage; user intents are replayed on recovery, playback commands never |

Two consequences worth stating on their own:

- **The queue is what keeps the station ours.** If it runs dry, Spotify autoplays
  and the walk starts *following* the player instead of driving it. So depth is
  measured in minutes of music, and the horizon counts the queue only — what is
  playing right now buys nothing, because when it ends we may be no more able to
  act than we are now.
- **The connection is not an error.** A dropped request is a normal condition for
  a radio on a train. It shows as a state of the device pill, not as an amber
  banner, and it says so in words only when the user reaches for a control that
  cannot work yet.

## Verification

Anything the sandbox cannot reach gets a stub, because a comment is not evidence.
The rule was learned the hard way: styling the Spotify embed's host element was
"verified" in an environment where the iFrame API never loaded, so nothing was
ever measured.

| script | what it proves |
| --- | --- |
| `scripts/walk.mjs` | the walk itself, in the terminal, with `--explain` and `--stats-only`. Runs in the deploy workflow as a smoke test |
| `scripts/net_tests.mjs` | what the radio does when the network comes and goes — Spotify stubbed at the network boundary with real state (a device, a current track, an actual queue), driven by Playwright. Every check asserts on what was **sent to the device** or what the screen **says** |
| `scripts/fit_tests.mjs` | whether the layout holds at eleven window sizes: the cover square and clear of the top bar, the title, the controls and the footer; the sleeve turning on a click; the panel's search field inside its column |

`net_tests.mjs` covers the eight cases that matter: a poll failing mid-track,
a tap on play during an outage, recovery after Spotify has moved on, a request
that never answers, a token refresh that fails for want of network, a refresh
token that is genuinely dead, a pocket plus an outage, and a real
`context.setOffline()` transition. It found a bug in the queue-depth rule that
reading the code had not: a nine-minute track made the horizon look covered and
left one track queued behind it.

`fit_tests.mjs` exists because the square cover has broken four times, each time
differently and each time invisibly at whatever window size the author happened
to have open: squashed by a flex column, clamped on one axis while the other
stood, collapsed to a sliver in landscape, and finally overflowing *upward* onto
the top bar on a window that was wide enough but not tall enough. The cover is
now bounded by the space actually left for it (`.cover-slot` is a size container)
rather than by the viewport, which makes that last case impossible rather than
unlikely.

Both need a Chromium and are development tools — the deploy workflow does not run
them.

## Failure, by design

The radio should degrade, never break:

- the live archive is unreachable → the vendored snapshot answers, with a notice
  that fades;
- cover art fails at any of its three stages → genre-tinted placeholder;
- the Spotify token is genuinely refused → `poll()` reports `authError` and the
  panel offers to reconnect; the walk itself keeps going. A token refresh that
  merely *could not be sent* is not that, and changes nothing;
- the connection drops mid-track → the screen keeps what it knew, the queue keeps
  being fed, and nothing is restarted;
- no active Spotify device → a plain message, and previews remain available;
- a corner of the graph is exhausted → the walk jumps, and says so;
- constraints make a step impossible → they are relaxed in a documented order
  (`RELAX_ORDER`), repeats last.

## Deliberately absent

- **No graph rendering.** That is New Release Atlas. The only trace of the graph
  here is one caption: *shared artist · Kenny Dope*.
- **No server, no API keys in the bundle.** PKCE, client-side, or nothing.
- **No playlist objects.** Not in the engine, not on Spotify. A radio that
  builds a playlist is a playlist with extra steps.
- **No AI.** The walk is a rule engine over a graph, so it is deterministic,
  free, private and works offline — the same choice the Atlas made for its
  prompt-to-playlist engine.
