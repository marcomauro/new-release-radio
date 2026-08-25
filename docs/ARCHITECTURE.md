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
| timers freeze when the app leaves the screen | the platform queue is filled to 3 while `document.hidden`, and the walk fast-forwards on return (`useRadio.js`, `QUEUE_DEPTH`) |
| a cross-origin iframe wants the tap inside itself | previews are the declared fallback on touch; Connect is offered first |
| fingers, not pointers | 34 px minimum on anything tappable, under `@media (hover: none)` |
| `100%` height measures the large viewport | `100dvh`, with `100%` as the fallback |
| a square that must fit two dimensions | the cover is driven by **height** + `aspect-ratio`; width-driven, a flex column squashes it (315×265 on a short phone, 225×33 in landscape) |
| landscape is wide and short | the stage becomes a two-column grid: cover left, everything else right |

## Failure, by design

The radio should degrade, never break:

- the live archive is unreachable → the vendored snapshot answers, with a notice
  that fades;
- cover art fails at any of its three stages → genre-tinted placeholder;
- the Spotify token dies mid-session → `poll()` reports `authError` and the panel
  offers to reconnect; the walk itself keeps going;
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
