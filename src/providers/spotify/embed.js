/* ----------------------------------------------------------------------------
   providers/spotify/embed.js — 30s previews, no account at all.

   The default provider: anyone opening the page hears the radio immediately.
   It drives the official Spotify iframe player, which means the preview is
   played by Spotify (as their terms require) while the walk, the cover and the
   whole interface stay ours.

   No QUEUE capability: previews are advanced by us, one track at a time, when
   the iframe reports the preview is over.

   The iframe lives off-screen: the interface has ONE player, ours. Everything
   the user can do here goes through our own controls, which is why pause and
   resume below are careful to use the real methods when the embed API exposes
   them and to fall back to togglePlay only when the state says it is safe.

   No CAPS.VOLUME: the embed API has no volume control at all (the level is the
   one set inside Spotify). The UI shows the volume slider disabled and says so,
   rather than pretending.
   -------------------------------------------------------------------------- */

import { CAPS, makeSnapshot } from '../provider.js'
import { coverFor } from './artwork.js'

let apiPromise = null

function loadIframeApi() {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve) => {
    if (typeof window === 'undefined') return
    if (window.__nrrSpotifyIframeApi) return resolve(window.__nrrSpotifyIframeApi)
    window.onSpotifyIframeApiReady = (API) => {
      window.__nrrSpotifyIframeApi = API
      resolve(API)
    }
    const s = document.createElement('script')
    s.src = 'https://open.spotify.com/embed/iframe-api/v1'
    s.async = true
    document.body.appendChild(s)
  })
  return apiPromise
}

export function preloadEmbedApi() {
  if (typeof window !== 'undefined') loadIframeApi()
}

const refOf = (track) => (track && track.id ? `spotify:track:${track.id}` : null)

export function createEmbedProvider() {
  let controller = null
  let host = null
  let ref = null
  let pendingRef = null // asked for before the controller existed
  let ended = null // ref whose preview just finished
  let snap = { playing: false, position: 0, duration: 0 }
  let message = ''

  async function ensureController() {
    if (controller || !host) return controller
    const API = await loadIframeApi()
    if (!API || !host) return null
    await new Promise((resolve) => {
      API.createController(
        host,
        { uri: pendingRef || 'spotify:track:58uRFOHOP3rnOgMqGnou91', width: '100%', height: 80 },
        (ctrl) => {
          controller = ctrl
          ctrl.addListener('playback_update', (e) => {
            const d = e && e.data
            if (!d) return
            const position = d.position || 0
            const duration = d.duration || 0
            snap = { playing: !d.isPaused, position, duration }
            // Two ways a preview ends: the iframe reaches the end of a short
            // clip, or it pauses at ~30s of a full-length track.
            const nearEnd = duration > 0 && position > 0 && position / duration >= 0.985
            const previewCap = duration > 45000 && position >= 29000 && d.isPaused
            if ((nearEnd || previewCap) && ref && ended !== ref) ended = ref
          })
          resolve()
        }
      )
    })
    return controller
  }

  return {
    id: 'spotify-embed',
    label: 'Spotify preview',
    blurb: '30 second previews · no login',
    caps: new Set([CAPS.PREVIEW, CAPS.ARTWORK]),

    async init() {
      loadIframeApi()
    },

    status() {
      return { available: true, authenticated: true, message, device: null }
    },

    /** The iframe needs a place to live; the UI hands us a small strip. */
    mount(el) {
      host = el
      if (host && pendingRef) ensureController().then(() => this.start({ id: pendingRef.split(':').pop() }))
    },

    unmount() {
      try {
        if (controller) controller.destroy()
      } catch (e) {
        /* noop */
      }
      controller = null
      host = null
    },

    async resolve(track) {
      return refOf(track)
    },

    trackIdFromRef(ref) {
      return ref && ref.startsWith('spotify:track:') ? ref.slice('spotify:track:'.length) : null
    },

    async start(track) {
      const uri = refOf(track)
      if (!uri) return
      pendingRef = uri
      const ctrl = await ensureController()
      ref = uri
      ended = null
      if (!ctrl) {
        message = 'loading the Spotify player…'
        return
      }
      message = ''
      try {
        ctrl.loadUri(uri)
        ctrl.play()
      } catch (e) {
        message = 'press play to start (the browser blocked autoplay)'
      }
    },

    async pause() {
      const ctrl = controller
      if (!ctrl) return
      try {
        if (typeof ctrl.pause === 'function') ctrl.pause()
        else if (snap.playing) ctrl.togglePlay()
        snap = { ...snap, playing: false }
      } catch (e) {
        /* noop */
      }
    },

    async resume() {
      const ctrl = controller
      if (!ctrl) return
      try {
        // `play()` would restart the preview from zero: only togglePlay resumes.
        if (typeof ctrl.resume === 'function') ctrl.resume()
        else if (!snap.playing) ctrl.togglePlay()
        snap = { ...snap, playing: true }
      } catch (e) {
        /* noop */
      }
    },

    async seek(ms) {
      try {
        controller && controller.seek(Math.round(ms / 1000))
      } catch (e) {
        /* noop */
      }
    },

    async poll() {
      const endedRef = ended
      ended = null
      return makeSnapshot({
        playing: snap.playing,
        position: snap.position,
        duration: Math.min(snap.duration || 0, 30000) || snap.duration,
        ref,
        endedRef,
        message,
      })
    },

    artwork(track) {
      return coverFor(track && track.id, { authenticated: false })
    },

    teardown() {
      this.unmount()
    },
  }
}
