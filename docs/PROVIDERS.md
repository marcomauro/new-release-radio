# Adding a streaming platform

Spotify is where the archive happens to live today. It is **not** baked into the
radio: everything above `src/providers/` deals in *archive tracks* and a single
playback contract. This document is what you need to add a second platform.

```
      core/            what plays next      ← knows nothing about any platform
        │
      radio/useRadio   the engine           ← speaks only the contract below
        │
      providers/       how it is heard      ← Spotify Connect · Spotify preview · Dry run
```

The proof this seam is real is the **Dry run** provider
([`src/providers/simulated.js`](../src/providers/simulated.js)): the whole radio
runs on a clock, with no streaming service at all, in 90 lines.

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
| `status()` | ✔ | `{ available, authenticated, message, device }` |
| `resolve(track)` | ✔ | archive track → platform ref (a URI, an URL, an internal id) |
| `trackIdFromRef(ref)` | ✔ | the inverse: platform ref → archive id, or `null` |
| `start(track)` | ✔ | play this track **now** |
| `poll()` | ✔ | a `Snapshot` — the single source of playback truth |
| `pause()`, `resume()` | ✔ | |
| `authenticate()` | – | start a login flow (may navigate away) |
| `enqueue(track)` | – | append after the current track (with `CAPS.QUEUE`) |
| `skip()` | – | platform-native "next" (with `CAPS.QUEUE`) |
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
  volume,        // 0-100 or null when unknown
  volumeAvailable, // false disables the slider (and the UI explains why)
}
```

### Capabilities decide the engine's strategy

| capability | consequence |
| --- | --- |
| `CAPS.QUEUE` | the engine starts playback once and **appends** each decided track. Continuity is the platform's job; the walk follows what `poll()` reports — including a track the *user* started, which simply becomes the new cursor position. |
| no `CAPS.QUEUE` | the engine advances the walk itself when `poll()` reports `endedRef`, then calls `start()`. |
| `CAPS.SEEK` | the progress line becomes draggable. |
| `CAPS.PREVIEW` | the UI expects a fragment, not a whole track. |
| `CAPS.ARTWORK` | covers come from the provider; otherwise the placeholder is used. |
| `CAPS.VOLUME` | the volume slider is live; without it the slider is shown disabled with the reason. |
| `CAPS.OUTPUTS` | the device pill appears in the top bar and in the panel. |
| `CAPS.SILENT` | no audio (dry run). |

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

---

## Registering it

```js
// src/providers/index.js
import { createTidalProvider } from './tidal/index.js'

export function createProviders() {
  return [createConnectProvider(), createEmbedProvider(), createTidalProvider(), createSimulatedProvider()]
}
```

That is the whole integration. The provider chip, the panel entry, the device
list, the seek behaviour and the artwork path all follow from `caps` and
`extras`. `preferredProviderId()` in the same file decides which one starts on
load — add your rule there if the new platform should win.
