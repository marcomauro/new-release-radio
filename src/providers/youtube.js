/* ----------------------------------------------------------------------------
   providers/youtube.js — whole tracks for everyone, no account.

   New Release Atlas resolves every archive track to a YouTube video offline
   (`scripts/resolve_sources.py` there) and publishes the match in graph.json as
   the node's `yt` field — the videoId. Only confirmed matches get one, so a
   track without `yt` has no video we trust, and this provider says so through
   `playable()`: the walk never chooses it (core/walker.js, `setPlayable`).

   It drives the official IFrame Player API, one video at a time. No QUEUE: the
   engine advances the walk when poll() reports the video ended, as with the
   preview embed.

   **The video stays on screen.** YouTube's terms want the player visible
   (at least 200×200), with nothing laid over it and no audio without its
   picture, so this is the one provider whose iframe is not caged out of sight:
   CAPS.VIDEO tells the UI to put it where the cover goes (ui/Cover.jsx). Our
   controls still drive it; YouTube's own are hidden. The domain is
   youtube-nocookie.com: no cookie until something plays.

   **What YouTube can refuse.** Some owners disable embedding (errors 101/150),
   some videos disappear (100). A refused track ends at once with `skipped` in
   the snapshot — the reason, said out loud by the engine — and is marked
   unplayable for the rest of the session so the walk does not pick it again.

   **Phones.** A mobile browser can refuse to start sound that a tap did not
   start, and a tap on OUR ▶ reaches YouTube's iframe only as a message. When a
   video sits there unstarted, the status says to tap the video itself, which
   is always allowed — worded so it also fits YouTube just being slow, which
   from out here looks exactly the same. And a phone pauses a video whose page is not on screen:
   unlike Spotify Connect, this player does not play in the background. The
   engine copes with that for every provider without QUEUE (radio/useRadio.js):
   it keeps the screen awake while something plays, and resumes on return.
   -------------------------------------------------------------------------- */

import { CAPS, makeSnapshot, ok, failed } from './provider.js'
import { coverFor } from './spotify/artwork.js'

let apiPromise = null

function loadIframeApi() {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return
    if (window.YT && window.YT.Player) return resolve(window.YT)
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev()
      resolve(window.YT)
    }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.async = true
    s.onerror = () => {
      apiPromise = null // a later mount may try again
      reject(new Error('the YouTube player could not be loaded'))
    }
    document.body.appendChild(s)
  })
  return apiPromise
}

// YT.PlayerState
const UNSTARTED = -1
const ENDED = 0
const PLAYING = 1
const PAUSED = 2
const BUFFERING = 3
const CUED = 5

// A video loaded and still not playing after this long gets a word on screen.
// It cannot say WHICH of two things is happening: the iframe reports the same
// "unstarted" for a phone waiting for a tap on the video and for YouTube simply
// taking its time (on the live site, desktop Chrome, a video regularly took
// 5–17 s to start). So the line says both, and blames neither.
const TAP_HINT_MS = 4000

/** onError code → why the track was skipped, as one short clause. */
function describeError(code) {
  if (code === 101 || code === 150) return 'its owner does not allow it to play outside YouTube'
  if (code === 100) return 'the video is no longer on YouTube'
  if (code === 153) return 'YouTube refused to play it here'
  return 'YouTube could not play it'
}

const refOf = (track) => (track && track.yt ? `youtube:${track.yt}` : null)

export function createYouTubeProvider() {
  let host = null
  let player = null
  let ready = false
  let loading = null // the player being created
  let ref = null // what we asked for
  let track = null
  let pending = null // a track asked for before the player was ready
  let ended = null // ref that just finished (or was refused)
  let skipped = ''
  let state = UNSTARTED
  let loadedAt = 0
  let message = ''
  const refused = new Set() // archive ids YouTube would not play this session
  const idOf = new Map() // videoId -> archive id, for trackIdFromRef

  const call = (fn) => {
    try {
      return player && ready ? fn(player) : undefined
    } catch (e) {
      return undefined
    }
  }

  function load(t) {
    track = t
    ref = refOf(t)
    ended = null
    skipped = ''
    state = UNSTARTED
    loadedAt = Date.now()
    message = ''
    call((p) => p.loadVideoById(t.yt))
  }

  function create() {
    if (loading || !host) return loading
    loading = loadIframeApi()
      .then((YT) => {
        if (!host) return
        // The API replaces the element it is given with its iframe, so it gets
        // a child of the host — the host itself belongs to React.
        const el = document.createElement('div')
        host.appendChild(el)
        player = new YT.Player(el, {
          host: 'https://www.youtube-nocookie.com',
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1, // never jump to the phone's fullscreen player
            controls: 0, // ours are the controls
            disablekb: 1, // Space and → belong to the radio
            fs: 0,
            rel: 0,
            iv_load_policy: 3,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              ready = true
              message = ''
              if (pending) {
                const t = pending
                pending = null
                load(t)
              }
            },
            onStateChange: (e) => {
              state = e.data
              if (state === PLAYING) message = ''
              if (state === ENDED && ref && ended !== ref) ended = ref
            },
            onError: (e) => {
              if (!track || !ref) return
              refused.add(track.id)
              skipped = `“${track.title}” skipped — ${describeError(e.data)}`
              ended = ref
            },
          },
        })
      })
      .catch((e) => {
        message = `${e.message} — check the connection, or choose another player`
      })
      .finally(() => {
        loading = null
      })
    return loading
  }

  return {
    id: 'youtube',
    label: 'YouTube',
    shortLabel: 'youtube',
    blurb: 'whole tracks · no login · the video plays where the cover is',
    caps: new Set([CAPS.FULL, CAPS.SEEK, CAPS.VOLUME, CAPS.ARTWORK, CAPS.VIDEO]),

    async init() {
      loadIframeApi().catch(() => {})
    },

    status() {
      const waiting =
        ready && ref && (state === UNSTARTED || state === CUED) && Date.now() - loadedAt > TAP_HINT_MS
      return {
        available: true,
        authenticated: true,
        message: message || (waiting ? 'waiting for YouTube to start — if nothing happens, tap the video' : ''),
        device: null,
      }
    },

    mount(el) {
      host = el
      create()
    },

    unmount() {
      call((p) => p.destroy())
      player = null
      ready = false
      host = null
      state = UNSTARTED
    },

    playable(t) {
      return !!(t && t.yt) && !refused.has(t.id)
    },

    async resolve(t) {
      const r = refOf(t)
      if (r) idOf.set(t.yt, t.id)
      return r
    },

    trackIdFromRef(r) {
      return r && r.startsWith('youtube:') ? idOf.get(r.slice('youtube:'.length)) || null : null
    },

    async start(t) {
      if (!this.playable(t)) return failed('http', `“${t ? t.title : '?'}” has no video on YouTube`)
      idOf.set(t.yt, t.id)
      if (!ready) {
        pending = t
        track = t
        ref = refOf(t)
        message = 'loading the YouTube player…'
        create()
        return ok()
      }
      load(t)
      return ok()
    },

    async pause() {
      call((p) => p.pauseVideo())
      if (state === PLAYING || state === BUFFERING) state = PAUSED
      return ok()
    },

    async resume() {
      call((p) => p.playVideo())
      return ok()
    },

    async seek(ms) {
      call((p) => p.seekTo(Math.max(0, ms) / 1000, true))
      return ok()
    },

    async setVolume(percent) {
      const v = Math.max(0, Math.min(100, Math.round(percent)))
      if (!ready) return failed('http', 'the YouTube player is still loading')
      call((p) => {
        p.setVolume(v)
        if (v > 0 && p.isMuted()) p.unMute()
      })
      return ok()
    },

    async poll() {
      const endedRef = ended
      const why = endedRef ? skipped : ''
      ended = null
      skipped = ''
      if (!ready) return makeSnapshot({ ref, endedRef, skipped: why, message })
      const live = call((p) => p.getPlayerState())
      if (typeof live === 'number') state = live
      const dur = call((p) => p.getDuration()) || 0
      return makeSnapshot({
        // Buffering after a play is still playing, as far as anyone can hear.
        playing: state === PLAYING || state === BUFFERING,
        position: (call((p) => p.getCurrentTime()) || 0) * 1000,
        duration: dur > 0 ? dur * 1000 : track && track.duration_sec ? track.duration_sec * 1000 : 0,
        ref,
        endedRef,
        skipped: why,
        volume: call((p) => (p.isMuted() ? 0 : p.getVolume())) ?? null,
        volumeAvailable: true,
        message,
      })
    },

    artwork(t) {
      return coverFor(t && t.id, { authenticated: false })
    },

    teardown() {
      this.pause()
    },
  }
}
