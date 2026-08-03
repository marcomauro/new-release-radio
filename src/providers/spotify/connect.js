/* ----------------------------------------------------------------------------
   providers/spotify/connect.js — full tracks, on the user's own device.

   The app is a remote control: the audio comes out of Spotify (desktop, phone,
   speaker), we only steer it. This is the provider that makes the radio a real
   radio — whole tracks, gapless, endless.

   How the endless stream works here: playback is started ONCE on the seed
   track, and every track the walk decides is appended with
   `POST /me/player/queue`. Spotify keeps playing without interruption, and the
   radio learns what is on air by polling `/me/player`. No playlist is ever
   created, nothing is ever restarted.
   -------------------------------------------------------------------------- */

import * as api from './api.js'
import { isLoggedIn, login, logout } from './auth.js'
import { coverFor } from './artwork.js'
import { CAPS, makeSnapshot } from '../provider.js'

const refOf = (track) => (track && track.id ? `spotify:track:${track.id}` : null)

export function createConnectProvider() {
  let device = null // { id, name, type }
  let devices = []
  let userPicked = false
  let authError = false
  let message = ''
  let started = false

  const isMobile = () =>
    typeof navigator !== 'undefined' && /iphone|ipad|android/i.test(navigator.userAgent)

  async function refreshDevices() {
    try {
      devices = await api.devices()
      authError = false
      if (!userPicked) {
        const active = devices.find((d) => d.is_active)
        const phone = devices.find((d) => d.type === 'Smartphone')
        const chosen = active || (isMobile() && phone) || devices[0] || null
        device = chosen ? { id: chosen.id, name: chosen.name, type: chosen.type } : null
      }
      message = devices.length ? '' : 'no active device — open Spotify anywhere, then press play'
      return devices
    } catch (e) {
      if (e && e.status === 401) authError = true
      return []
    }
  }

  async function ensureDevice() {
    if (!device) await refreshDevices()
    return device
  }

  function handleError(e) {
    if (!e) return
    if (e.status === 401) {
      authError = true
      message = 'session expired — reconnect Spotify'
      return
    }
    if (e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404) {
      message = 'no active device — open Spotify and press play once'
      device = null
      return
    }
    if (e.reason === 'PREMIUM_REQUIRED') {
      message = 'Spotify Premium is required for full tracks'
      return
    }
    if (e.status === 429) {
      message = 'Spotify is rate-limiting: slowing down'
      return
    }
    message = e.message || 'Spotify refused the command'
  }

  return {
    id: 'spotify-connect',
    label: 'Spotify Connect',
    blurb: 'full tracks on your Spotify device · Premium',
    caps: new Set([CAPS.FULL, CAPS.REMOTE, CAPS.QUEUE, CAPS.ARTWORK, CAPS.SEEK]),

    async init() {
      if (isLoggedIn()) await refreshDevices()
    },

    status() {
      return {
        available: true,
        authenticated: isLoggedIn() && !authError,
        message,
        device: device ? device.name : null,
      }
    },

    authenticate: login,
    signOut() {
      logout()
      authError = false
      started = false
      device = null
      devices = []
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
      await ensureDevice()
      try {
        await api.play([uri], device ? device.id : undefined)
        started = true
        message = ''
      } catch (e) {
        // A silent device usually just needs the transfer first.
        if (device && (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE')) {
          try {
            await api.transfer(device.id, false)
            await api.play([uri], device.id)
            started = true
            message = ''
            return
          } catch (e2) {
            handleError(e2)
            return
          }
        }
        handleError(e)
      }
    },

    async enqueue(track) {
      const uri = refOf(track)
      if (!uri || !started) return false
      try {
        await api.queue(uri, device ? device.id : undefined)
        return true
      } catch (e) {
        handleError(e)
        return false
      }
    },

    async pause() {
      try {
        await api.pause()
      } catch (e) {
        handleError(e)
      }
    },

    async resume() {
      try {
        await api.resume()
      } catch (e) {
        handleError(e)
      }
    },

    async seek(ms) {
      try {
        await api.seek(ms)
      } catch (e) {
        handleError(e)
      }
    },

    /** Skip is a real "next" on the device: the queued track starts at once. */
    async skip() {
      try {
        await api.next()
        return true
      } catch (e) {
        handleError(e)
        return false
      }
    },

    async poll() {
      try {
        const s = await api.state()
        authError = false
        if (!s || !s.item) {
          return makeSnapshot({ message: message || (started ? '' : 'ready'), playing: false })
        }
        const imgs = (s.item.album && s.item.album.images) || []
        if (s.device) device = { id: s.device.id, name: s.device.name, type: s.device.type }
        return makeSnapshot({
          playing: !!s.is_playing,
          position: s.progress_ms || 0,
          duration: s.item.duration_ms || 0,
          ref: `spotify:track:${s.item.id}`,
          artwork: imgs.length ? { url: imgs[0].url, fallback: imgs[imgs.length - 1].url } : null,
          message,
        })
      } catch (e) {
        if (e && e.status === 401) {
          authError = true
          return makeSnapshot({ authError: true, message: 'session expired — reconnect Spotify' })
        }
        handleError(e)
        return makeSnapshot({ message })
      }
    },

    artwork(track) {
      return coverFor(track && track.id, { authenticated: true })
    },

    teardown() {
      started = false
    },

    // Provider-specific extras: the device row in the UI. Anything outside the
    // contract lives here, so the shared code never depends on it.
    extras: {
      listDevices: refreshDevices,
      get devices() {
        return devices
      },
      get device() {
        return device
      },
      async select(id) {
        userPicked = true
        const d = devices.find((x) => x.id === id)
        if (!d) return
        device = { id: d.id, name: d.name, type: d.type }
        try {
          await api.transfer(d.id, true)
          message = ''
        } catch (e) {
          handleError(e)
        }
      },
    },
  }
}
