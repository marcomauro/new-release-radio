/* ----------------------------------------------------------------------------
   providers/provider.js — the playback contract.

   The radio decides WHAT to play (core/) and a provider decides HOW it is
   heard. Spotify is the first implementation, not an assumption: nothing above
   this line imports a Spotify module, and the walker only ever deals in
   archive tracks (`{ id, title, artist, … }` straight out of graph.json).

   A provider is a plain object:

     id            stable slug, e.g. 'spotify-connect'
     label         shown in the UI
     blurb         one line: what the user gets
     caps          Set of CAPS values
     init()                      → complete a pending OAuth redirect, load SDKs
     status()                    → { available, authenticated, message, device }
     authenticate()              → start a login flow (may navigate away)
     mount(el) / unmount()       → optional DOM host (iframe embeds)
     resolve(track)              → platform ref for an archive track, or null
     trackIdFromRef(ref)         → archive id for a platform ref, or null
     start(track)                → play this track now
     enqueue(track)              → append after the current one (CAPS.QUEUE)
     skip()                      → optional: platform-native "next" (CAPS.QUEUE)
     pause() / resume() / seek(ms)
     poll()                      → Snapshot, the single source of playback truth
     artwork(track)              → { url, fallback } or null
     teardown()
     extras                      → anything platform-specific (device picker …)

   Snapshot (everything optional except `playing`):
     { playing, position, duration, ref, endedRef, artwork, message, authError }

   `poll()` is how the radio learns that a track finished: useRadio compares
   `ref` with what it asked for and advances the walk. A provider that pushes
   events instead can just keep the last event and return it from poll().

   To add a platform: implement this object, register it in providers/index.js.
   Nothing else changes. See docs/PROVIDERS.md.
   -------------------------------------------------------------------------- */

export const CAPS = {
  FULL: 'full-tracks', // plays whole tracks
  PREVIEW: 'preview', // plays a fragment only (30s)
  REMOTE: 'remote-device', // audio comes out of another device
  QUEUE: 'queue', // can append the next track without restarting playback
  ARTWORK: 'artwork', // can resolve cover art
  SEEK: 'seek',
  SILENT: 'silent', // no audio at all (rule development)
}

export function makeSnapshot(partial = {}) {
  return {
    playing: false,
    position: 0,
    duration: 0,
    ref: null,
    endedRef: null,
    artwork: null,
    message: '',
    authError: false,
    ...partial,
  }
}

/** Small helper: providers are optional, so every call goes through a guard. */
export async function safe(fn, fallback = null) {
  try {
    return await fn()
  } catch (e) {
    return fallback
  }
}
