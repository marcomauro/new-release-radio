# Adding a streaming platform

Spotify is where the archive happens to live today. It is **not** baked into the
radio: everything above `src/providers/` deals in *archive tracks* and a single
playback contract. This document is what you need to add a second platform.

```
      core/            what plays next      ← knows nothing about any platform
        │
      radio/useRadio   the engine           ← speaks only the contract below
        │
      providers/       how it is heard      ← Spotify Connect · YouTube
```

The proof this seam is real is the **YouTube** provider
([`src/providers/youtube.js`](../src/providers/youtube.js)): a second platform,
with no account, a video instead of a remote device, and tracks it does not
have — and nothing above `providers/` knows it is there.

---

## The contract

A provider is a plain object (see
[`src/providers/provider.js`](../src/providers/provider.js) for the canonical
version):

| member | required | what it does |
| --- | --- | --- |
| `id`, `label`, `blurb` | ✔ | identity and the one line shown in the panel |
| `caps` | ✔ | `Set` of `CAPS` values — the engine branches on these, never on `id` |
| `init()` | ✔ | finish a pending OAuth redirect, load an SDK |
| `status()` | ✔ | `{ available, authenticated, message, messageKind, device }` — `messageKind: 'network'` keeps a dropped connection off the notice line, where it belongs to the device pill instead |
| `resolve(track)` | ✔ | archive track → platform ref (a URI, an URL, an internal id) |
| `playable(track)` | – | synchronous: `false` when the platform cannot play this track at all. The engine hands it to the walk (`station.setPlayable`), which then never chooses such a track, and passes over a current one out loud. See "Tracks a platform does not have" below |
| `trackIdFromRef(ref)` | ✔ | the inverse: platform ref → archive id, or `null` |
| `start(track)` | ✔ | play this track **now** |
| `poll()` | ✔ | a `Snapshot` — the single source of playback truth |
| `pause()`, `resume()` | ✔ | |
| `authenticate()` | – | start a login flow (may navigate away) |
| `enqueue(track)` | – | append after the current track (with `CAPS.QUEUE`) |
| `skip()` | – | platform-native "next" (with `CAPS.QUEUE`) |
| `queuedRefs()` | – | with `CAPS.QUEUE`: the refs the platform itself says it will play next, in order, or `null` when it cannot say. The engine reconciles its own record against this, because after an outage that record can be wrong in both directions |
| `seek(ms)` | – | with `CAPS.SEEK` |
| `setVolume(0..100)` | – | with `CAPS.VOLUME` |
| `listOutputs()` / `outputs()` / `currentOutput()` / `selectOutput(id)` | – | with `CAPS.OUTPUTS`: the device pill in the top bar is built from these, so a new platform gets it for free. Return `{ id, name, kind, active, volume, supportsVolume }`. |
| `adopt(ref)` | – | take over a session that is already playing, without sending a play command |
| `mount(el)` / `unmount()` | – | for platforms that need a DOM host (iframes). **Assume the host element can be replaced**: Spotify's iFrame API swaps it for its own `<iframe>`, which is why the UI hands over a child inside a styled cage rather than a styled element. |
| `artwork(track)` | – | `{ url, fallback }` or `null`, with `CAPS.ARTWORK` |
| `teardown()` | – | called when the user switches provider |
| `extras` | – | anything platform-specific (the Spotify device picker lives here) |

### Snapshot

```js
{
  playing,    // boolean
  position,   // ms into the track
  duration,   // ms
  ref,        // what is on air, in platform terms
  endedRef,   // set once, when a track just finished (providers without QUEUE)
  artwork,    // { url, fallback } when the platform hands it to you for free
  message,    // human-readable status ("no active device", …)
  authError,  // the session died: the UI offers to reconnect
  stale,      // WE COULD NOT ASK — nothing else in here is news
  volume,        // 0-100 or null when unknown
  volumeAvailable, // false disables the slider (and the UI explains why)
  skipped,    // with an endedRef that ended early: why, in one sentence (said out loud)
}
```

`stale` decides how the whole snapshot is read. It means the platform did not
answer — the request never left, or it timed out — and the engine keeps the
state it already had, moving the position on the local clock instead. Everything
else in a stale snapshot is ignored, so a provider that cannot reach its
platform returns `staleSnapshot(message)` and nothing more.

**Never report silence as `playing: false`.** A refusal changes what is true; a
lost request only changes what you know. Reporting the second as the first is
what made a few seconds of bad mobile signal look like a stopped radio, put a ▶
on screen while Spotify was playing, and turned the next tap into a restart.

### Result

Every command — `start`, `enqueue`, `skip`, `pause`, `resume`, `seek`,
`setVolume`, `selectOutput` — answers with:

```js
{ ok, kind, message }   // kind: '' | 'network' | 'http' | 'auth'
```

`kind: 'network'` is the one the engine treats differently: a command that may
never have arrived can be replayed when the connection returns (the user's
volume, moving the stream to another device), while one that was *refused* must
not be. Playback commands are never replayed either way — a duplicate `next` is
audible, and a lost answer cannot be told from a lost request.

Helpers for all three shapes are in `providers/provider.js`: `makeSnapshot`,
`staleSnapshot`, `ok`, `failed`.

### Capabilities decide the engine's strategy

| capability | consequence |
| --- | --- |
| `CAPS.QUEUE` | the engine starts playback once and **appends** each decided track. Continuity is the platform's job; the walk follows what `poll()` reports — including a track the *user* started, which simply becomes the new cursor position. |
| no `CAPS.QUEUE` | the engine advances the walk itself when `poll()` reports `endedRef`, then calls `start()`. |
| `CAPS.SEEK` | the progress line becomes draggable. |
| `CAPS.ARTWORK` | covers come from the provider; otherwise the placeholder is used. |
| `CAPS.VOLUME` | the volume slider is live; without it the slider is shown disabled with the reason. |
| `CAPS.OUTPUTS` | the device pill appears in the top bar and in the panel. |
| `CAPS.VIDEO` | the player is a video that must stay on screen: its host goes in the cover's square. |

`CAPS.QUEUE` is the one worth implementing: it is what makes the stream truly
gapless, because the platform never waits for us between tracks.

**On joining a running session.** If your platform can already be playing when
the page loads, report it from `poll()` and implement `adopt(ref)`. The engine
calls `adopt` instead of `start`, so nothing restarts, and it moves the walk onto
the playing track when the archive knows it. A provider that always calls `start`
turns a remote control back into a second player.

---

## Matching tracks on a platform that is not Spotify

The archive identifies a track by its **Spotify id** (that is where the
playlists came from). On another platform, `resolve()` has to *find* the track:

```js
async resolve(track) {
  const hit = cache.get(track.id)
  if (hit !== undefined) return hit
  const found = await platformSearch(`${track.title} ${track.artist}`, track.duration_sec)
  cache.set(track.id, found ? found.uri : null)   // cache negatives too
  return found ? found.uri : null
}
```

Notes from experience with this archive:

- Match on **title + primary artist**, then confirm with `duration_sec` (±3 s).
  The archive is full of remixes and long 12" versions whose titles differ only
  by a suffix — duration is the tiebreaker.
- Titles are kept **byte-exact** in the archive on purpose (one is 255 code
  points of combining marks). Do not normalise them before searching; strip only
  what the search API cannot handle, and never rewrite the stored value.
- `trackIdFromRef` must be the exact inverse of your `resolve` so the engine can
  recognise a track the platform started on its own.
- A track that cannot be matched should return `null` — the engine treats it as
  a dead end and the walk moves on. Do not substitute a different recording.

### Tracks a platform does not have

[`src/providers/youtube.js`](../src/providers/youtube.js) is the worked
example. Its matches are resolved **offline**, by New Release Atlas, and arrive
in `graph.json` as the node's `yt` field — so `resolve()` is a lookup and
`playable()` can answer synchronously. That is what lets the walk itself avoid
the gaps: a station told `setPlayable(fn)` drops every candidate `fn` rejects,
before any rule scores it, and never relaxes that (a track nobody can hear is
not a choice). Only if it would leave nothing at all does the walk go on as if
it were not there, and the engine says the player has nothing to play.

What the offline match cannot know — an owner who disables embedding later — is
found at play time: the provider ends the track with `endedRef` and a `skipped`
reason, and from then on reports it unplayable for the session.

---

## Registering it

```js
// src/providers/index.js
import { createTidalProvider } from './tidal/index.js'

export function createProviders() {
  return [createConnectProvider(), createYouTubeProvider(), createTidalProvider()]
}
```

That is the whole integration. The provider chip, the panel entry, the device
list, the seek behaviour and the artwork path all follow from `caps` and
`extras`. `preferredProviderId()` in the same file decides which one starts on
load — add your rule there if the new platform should win.
