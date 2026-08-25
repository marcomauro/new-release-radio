/* ----------------------------------------------------------------------------
   providers/simulated.js — the radio with the sound off.

   No streaming service, no account, no network: a clock pretends each track
   plays for its archive duration (sped up, by default 8×). It exists for two
   reasons:

   • it is how we develop and watch the traversal rules — hours of walking in
     minutes, with the covers and the "why" captions running past;
   • it proves the provider seam is real. If the radio can run with no platform
     at all, adding a second platform is an afternoon, not a rewrite.
   -------------------------------------------------------------------------- */

import { CAPS, makeSnapshot } from './provider.js'
import { coverFor } from './spotify/artwork.js'

export function createSimulatedProvider({ speed = 8 } = {}) {
  let ref = null
  let duration = 0
  let startedAt = 0
  let pausedAt = 0
  let playing = false
  let ended = null
  let rate = speed
  let vol = 70 // nothing to hear, but the control has to be exercisable

  const now = () => Date.now()
  const elapsed = () => (playing ? (now() - startedAt) * rate : pausedAt)

  return {
    id: 'simulated',
    label: 'Dry run',
    shortLabel: 'dry run',
    blurb: `silent walk at ${speed}× · for tuning the rules`,
    caps: new Set([CAPS.SILENT, CAPS.ARTWORK, CAPS.SEEK, CAPS.VOLUME]),

    async init() {},
    status() {
      // No message: the notice line is for problems, and a dry run is not one.
      // The speed lives in the panel (extras.setSpeed) and in the chip's blurb.
      return { available: true, authenticated: true, message: '', device: null }
    },

    async resolve(track) {
      return track && track.id ? `sim:${track.id}` : null
    },

    trackIdFromRef(ref) {
      return ref && ref.startsWith('sim:') ? ref.slice(4) : null
    },

    async start(track) {
      if (!track) return
      ref = `sim:${track.id}`
      duration = (track.duration_sec || 210) * 1000
      startedAt = now()
      pausedAt = 0
      playing = true
      ended = null
    },

    async pause() {
      if (!playing) return
      pausedAt = elapsed()
      playing = false
    },

    async resume() {
      if (playing) return
      startedAt = now() - pausedAt / rate
      playing = true
    },

    async seek(ms) {
      pausedAt = Math.max(0, Math.min(ms, duration))
      if (playing) startedAt = now() - pausedAt / rate
    },

    async setVolume(percent) {
      vol = Math.max(0, Math.min(100, Math.round(percent)))
      return { ok: true, message: '' }
    },

    async poll() {
      const pos = Math.min(elapsed(), duration)
      if (playing && duration > 0 && pos >= duration && ended !== ref) ended = ref
      const endedRef = ended
      if (endedRef) {
        ended = null
        playing = false
      }
      return makeSnapshot({
        playing,
        position: pos,
        duration,
        ref,
        endedRef,
        volume: vol,
        volumeAvailable: true,
      })
    },

    artwork(track) {
      return coverFor(track && track.id, { authenticated: false })
    },

    teardown() {
      playing = false
    },

    extras: {
      get speed() {
        return rate
      },
      setSpeed(v) {
        const pos = elapsed()
        rate = Math.max(1, Math.min(240, v))
        pausedAt = pos
        if (playing) startedAt = now() - pos / rate
      },
    },
  }
}
