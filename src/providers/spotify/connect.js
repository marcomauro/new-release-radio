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

   Two things this provider is careful about:
   • an ALREADY RUNNING Spotify session is something to join, not to interrupt —
     `poll()` reports it and the engine adopts it (see radio/useRadio.js);
   • `start()` never restarts a track that is already the one on air.
   -------------------------------------------------------------------------- */

import * as api from './api.js'
import { isLoggedIn, login, logout } from './auth.js'
import { coverFor } from './artwork.js'
import { CAPS, makeSnapshot } from '../provider.js'

const refOf = (track) => (track && track.id ? `spotify:track:${track.id}` : null)

// Spotify device types -> the short word the UI shows under the name.
const KIND = {
  Computer: 'computer',
  Smartphone: 'phone',
  Tablet: 'tablet',
  Speaker: 'speaker',
  TV: 'tv',
  AVR: 'amplifier',
  STB: 'set-top box',
  CastVideo: 'cast',
  CastAudio: 'cast',
  Automobile: 'car',
  GameConsole: 'console',
}

export function createConnectProvider() {
  let device = null // { id, name, type, volume, supportsVolume }
  let devices = []
  let userPicked = false
  let authError = false
  let message = ''
  let started = false
  let lastRef = null // what Spotify last told us is on air

  const isMobile = () =>
    typeof navigator !== 'undefined' && /iphone|ipad|android/i.test(navigator.userAgent)

  const asDevice = (d) =>
    d && {
      id: d.id,
      name: d.name,
      type: d.type,
      kind: KIND[d.type] || (d.type || '').toLowerCase(),
      active: !!d.is_active,
      volume: typeof d.volume_percent === 'number' ? d.volume_percent : null,
      supportsVolume: d.supports_volume !== false,
    }

  async function refreshDevices() {
    try {
      devices = (await api.devices()).map(asDevice).filter(Boolean)
      authError = false
      if (!userPicked || !devices.some((d) => d.id === (device && device.id))) {
        const active = devices.find((d) => d.active)
        const phone = devices.find((d) => d.type === 'Smartphone')
        device = active || (isMobile() && phone) || devices[0] || null
      }
      message = devices.length
        ? ''
        : 'no Spotify device found — open Spotify on any device, then press play'
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
    shortLabel: 'Connect',
    blurb: 'full tracks on your Spotify device · Premium',
    caps: new Set([
      CAPS.FULL,
      CAPS.REMOTE,
      CAPS.QUEUE,
      CAPS.ARTWORK,
      CAPS.SEEK,
      CAPS.VOLUME,
      CAPS.OUTPUTS,
    ]),

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
      lastRef = null
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
      // Already on air: joining a running session must not restart it.
      if (uri === lastRef && started) {
        try {
          await api.resume()
          return
        } catch (e) {
          /* fall through to a normal start */
        }
      }
      await ensureDevice()
      try {
        await api.play([uri], device ? device.id : undefined)
        started = true
        lastRef = uri
        message = ''
      } catch (e) {
        // A silent device usually just needs the transfer first.
        if (device && (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE')) {
          try {
            await api.transfer(device.id, false)
            await api.play([uri], device.id)
            started = true
            lastRef = uri
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

    /** Adopt whatever is already playing: no command sent, just bookkeeping. */
    adopt(ref) {
      started = true
      lastRef = ref
      message = ''
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

    /** 0–100. Spotify applies it to the active device. */
    async setVolume(percent) {
      const v = Math.max(0, Math.min(100, Math.round(percent)))
      if (device) device = { ...device, volume: v }
      try {
        await api.volume(v, device ? device.id : undefined)
      } catch (e) {
        // Devices that cannot be volumed report 403 — say so once, quietly.
        if (e && e.status === 403) message = 'this device does not accept remote volume'
        else handleError(e)
      }
    },

    /* --- outputs (Spotify devices) ---------------------------------------- */

    async listOutputs() {
      return refreshDevices()
    },

    outputs() {
      return devices
    },

    currentOutput() {
      return device
    },

    async selectOutput(id) {
      const d = devices.find((x) => x.id === id)
      if (!d) return
      userPicked = true
      device = d
      try {
        // `play: true` moves the stream to the new device without a gap.
        await api.transfer(d.id, true)
        message = ''
      } catch (e) {
        handleError(e)
      }
    },

    async poll() {
      try {
        const s = await api.state()
        authError = false
        if (s && s.device) {
          const d = asDevice(s.device)
          if (d) {
            device = d
            const i = devices.findIndex((x) => x.id === d.id)
            if (i >= 0) devices[i] = d
          }
        }
        if (!s || !s.item) {
          return makeSnapshot({
            playing: false,
            message: message || (started ? '' : 'ready'),
            volume: device ? device.volume : null,
            volumeAvailable: !!(device && device.supportsVolume),
          })
        }
        const imgs = (s.item.album && s.item.album.images) || []
        lastRef = `spotify:track:${s.item.id}`
        return makeSnapshot({
          playing: !!s.is_playing,
          position: s.progress_ms || 0,
          duration: s.item.duration_ms || 0,
          ref: lastRef,
          artwork: imgs.length ? { url: imgs[0].url, fallback: imgs[imgs.length - 1].url } : null,
          message,
          volume: device ? device.volume : null,
          volumeAvailable: !!(device && device.supportsVolume),
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
  }
}
