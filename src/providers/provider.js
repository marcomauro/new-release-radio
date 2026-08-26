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
     adopt(ref)                  → optional: take over a session already playing
     enqueue(track)              → append after the current one (CAPS.QUEUE).
                                   Returns a Result (below)
     skip()                      → optional: platform-native "next" (CAPS.QUEUE).
                                   Returns a Result
     queuedRefs()                → optional (CAPS.QUEUE): the refs the platform
                                   itself says it will play next, in order, or
                                   null when it cannot say. The authority the
                                   engine reconciles its own record against
     pause() / resume() / seek(ms)
     setVolume(0..100)           → CAPS.VOLUME. Returns a Result: a platform
                                   that refuses (a phone sets its own volume)
                                   must say so, so the UI can stop offering a
                                   control that cannot work
     listOutputs() / outputs() / currentOutput() / selectOutput(id)
                                 → CAPS.OUTPUTS: where the audio comes out
     poll()                      → Snapshot, the single source of playback truth
     artwork(track)              → { url, fallback } or null
     teardown()
     extras                      → anything platform-specific (device picker …)

   Snapshot (everything optional except `playing`):
     { playing, position, duration, ref, endedRef, artwork, message, authError,
       stale, volume, volumeAvailable }

   Result, the answer to every command:
     { ok, kind, message }   kind: '' | 'network' | 'http' | 'auth'

   **`stale` is the one field that changes how a snapshot is read.** It means
   "no answer, so nothing here is news" — the engine keeps the last known state
   instead of overwriting it. A provider that cannot reach its platform MUST say
   `stale: true` rather than reporting silence as `playing: false`: a refusal
   changes what is true, a lost request only changes what we know. The same
   distinction drives `kind: 'network'` on a Result — a command that never
   arrived can be replayed, a command that was refused must not be.

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
  VOLUME: 'volume', // can set the playback volume
  OUTPUTS: 'outputs', // can list and switch the device the audio comes out of
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
    stale: false,
    volume: null,
    volumeAvailable: false,
    ...partial,
  }
}

/**
 * "We could not ask." Everything except the message is left out on purpose:
 * a stale snapshot is merged onto the last known state, and any field it
 * carried would overwrite something true with a default.
 */
export const staleSnapshot = (message = '') => ({ stale: true, message })

/** The answer to a command. `kind: 'network'` means it may never have arrived. */
export const ok = (message = '') => ({ ok: true, kind: '', message })
export const failed = (kind, message) => ({ ok: false, kind: kind || 'http', message: message || '' })

/** Small helper: providers are optional, so every call goes through a guard. */
export async function safe(fn, fallback = null) {
  try {
    return await fn()
  } catch (e) {
    return fallback
  }
}
