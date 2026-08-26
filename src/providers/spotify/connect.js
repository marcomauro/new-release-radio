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

   Three things this provider is careful about:
   • an ALREADY RUNNING Spotify session is something to join, not to interrupt —
     `poll()` reports it and the engine adopts it (see radio/useRadio.js);
   • `start()` never restarts a track that is already the one on air;
   • **silence is not an answer.** When a request never arrives, `poll()` says
     `stale: true` and reports nothing else, so the engine keeps the state it
     had. Reporting a lost request as `playing: false` is what made a few
     seconds of bad signal look like a stopped radio — and made the next tap on
     play restart the track.
   -------------------------------------------------------------------------- */

import * as api from './api.js'
import { isLoggedIn, login, logout } from './auth.js'
import { coverFor } from './artwork.js'
import { CAPS, makeSnapshot, staleSnapshot, ok, failed } from '../provider.js'

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

// What the user reads when the network is the problem. Never the browser's own
// wording: "Failed to fetch" is a fact about a fetch, not about their music.
const OFFLINE_NOTE = 'connection lost — the radio is waiting for the network'

export function createConnectProvider() {
  let device = null // { id, name, type, volume, supportsVolume }
  let devices = []
  let userPicked = false
  let authError = false
  let started = false
  let lastRef = null // what Spotify last told us is on air
  // The notice, with the reason it exists. Transient kinds are cleared by the
  // next successful poll; the others are cleared by whatever fixes them.
  let notice = { kind: '', text: '' }
  // Devices that answered a volume command with a real refusal. A phone usually
  // does: its level is the operating system's, not Spotify's to set. A network
  // failure must never land a device in here — that used to disable the slider
  // for the rest of the session over a lost request.
  const volumeRefused = new Set()

  const isMobile = () =>
    typeof navigator !== 'undefined' && /iphone|ipad|android/i.test(navigator.userAgent)

  const say = (kind, text) => {
    notice = { kind, text }
  }
  const clearTransient = () => {
    if (notice.kind === 'network' || notice.kind === 'rate' || notice.kind === 'refused') {
      notice = { kind: '', text: '' }
    }
  }

  const asDevice = (d) =>
    d && {
      id: d.id,
      name: d.name,
      type: d.type,
      kind: KIND[d.type] || (d.type || '').toLowerCase(),
      active: !!d.is_active,
      volume: typeof d.volume_percent === 'number' ? d.volume_percent : null,
      supportsVolume: d.supports_volume !== false && !volumeRefused.has(d.id),
    }

  async function refreshDevices() {
    try {
      devices = (await api.devices()).map(asDevice).filter(Boolean)
      authError = false
      clearTransient()
      if (!userPicked || !devices.some((d) => d.id === (device && device.id))) {
        const active = devices.find((d) => d.active)
        const phone = devices.find((d) => d.type === 'Smartphone')
        device = active || (isMobile() && phone) || devices[0] || null
      }
      if (!devices.length) {
        say('device', 'no Spotify device found — open Spotify on any device, then press play')
      } else if (notice.kind === 'device') {
        notice = { kind: '', text: '' }
      }
      return devices
    } catch (e) {
      // A lost request must not empty the device list: the devices are still
      // there, we just could not ask. Only a real answer changes the list.
      handleError(e)
      return devices
    }
  }

  async function ensureDevice() {
    if (!device) await refreshDevices()
    return device
  }

  /** One place turns an error into a state and a sentence. */
  function handleError(e) {
    if (!e) return ''
    if (api.isNetworkError(e)) {
      say('network', OFFLINE_NOTE)
      return notice.text
    }
    if (api.isAuthError(e) || e.status === 401) {
      // Only a real refusal ends the session. `acquireToken` has already made
      // sure a network failure never arrives here as an auth error.
      authError = true
      say('auth', 'session expired — reconnect Spotify')
      return notice.text
    }
    if (e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404) {
      say('device', 'no active device — open Spotify and press play once')
      device = null
      return notice.text
    }
    if (e.reason === 'PREMIUM_REQUIRED') {
      say('premium', 'Spotify Premium is required for full tracks')
      return notice.text
    }
    if (e.status === 429) {
      say('rate', 'Spotify is rate-limiting: slowing down')
      return notice.text
    }
    // An HTTP error carries Spotify's own message, which is safe to show.
    say('refused', e.message || 'Spotify refused the command')
    return notice.text
  }

  const fail = (e) => failed(api.isNetworkError(e) ? 'network' : api.isAuthError(e) ? 'auth' : 'http', handleError(e))

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
        message: notice.text,
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
      notice = { kind: '', text: '' }
    },

    async resolve(track) {
      return refOf(track)
    },

    trackIdFromRef(ref) {
      return ref && ref.startsWith('spotify:track:') ? ref.slice('spotify:track:'.length) : null
    },

    async start(track) {
      const uri = refOf(track)
      if (!uri) return failed('http', 'not a playable track')
      // Already on air: joining a running session must not restart it.
      if (uri === lastRef && started) {
        try {
          await api.resume()
          clearTransient()
          return ok()
        } catch (e) {
          // A network failure here says nothing about what is playing: do NOT
          // fall through to a `play`, which would restart the track.
          if (api.isNetworkError(e)) return fail(e)
        }
      }
      await ensureDevice()
      try {
        await api.play([uri], device ? device.id : undefined)
        started = true
        lastRef = uri
        clearTransient()
        return ok()
      } catch (e) {
        // A silent device usually just needs the transfer first — but only when
        // Spotify actually said so. A lost request means try again later.
        if (device && !api.isNetworkError(e) && (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE')) {
          try {
            await api.transfer(device.id, false)
            await api.play([uri], device.id)
            started = true
            lastRef = uri
            clearTransient()
            return ok()
          } catch (e2) {
            return fail(e2)
          }
        }
        return fail(e)
      }
    },

    /** Adopt whatever is already playing: no command sent, just bookkeeping. */
    adopt(ref) {
      started = true
      lastRef = ref
      clearTransient()
    },

    async enqueue(track) {
      const uri = refOf(track)
      if (!uri) return failed('http', 'not a playable track')
      if (!started) return failed('http', 'nothing is playing yet')
      try {
        await api.queue(uri, device ? device.id : undefined)
        clearTransient()
        return ok()
      } catch (e) {
        return fail(e)
      }
    },

    /**
     * What Spotify says it will play next. Used to correct our own record after
     * an outage, when it can be wrong in both directions: a command whose
     * response was lost did land, a command we believed landed did not.
     *
     * The list can also contain Spotify's own autoplay suggestions once our
     * queue runs out, so the engine keeps only the refs it handed over itself.
     * @returns {Promise<string[]|null>} null = could not ask
     */
    async queuedRefs() {
      try {
        const q = await api.queueState()
        clearTransient()
        return ((q && q.queue) || []).map((t) => refOf(t)).filter(Boolean)
      } catch (e) {
        handleError(e)
        return null
      }
    },

    async pause() {
      try {
        await api.pause()
        return ok()
      } catch (e) {
        return fail(e)
      }
    },

    async resume() {
      try {
        await api.resume()
        clearTransient()
        return ok()
      } catch (e) {
        return fail(e)
      }
    },

    async seek(ms) {
      try {
        await api.seek(ms)
        return ok()
      } catch (e) {
        return fail(e)
      }
    },

    /** Skip is a real "next" on the device: the queued track starts at once. */
    async skip() {
      try {
        await api.next()
        clearTransient()
        return ok()
      } catch (e) {
        return fail(e)
      }
    },

    /**
     * 0–100 on the active device. Says whether it took, because a refusal is
     * not an edge case: the Spotify app on a phone maps volume to the operating
     * system's, and answers 403. Reporting that lets the UI stop offering a
     * control that cannot work, instead of letting the slider spring back to
     * its old value at the next poll and inviting another try.
     *
     * A network failure is NOT a refusal: the device keeps its right to volume.
     */
    async setVolume(percent) {
      const v = Math.max(0, Math.min(100, Math.round(percent)))
      const target = device
      if (device) device = { ...device, volume: v }
      try {
        await api.volume(v, target ? target.id : undefined)
        clearTransient()
        return ok()
      } catch (e) {
        if (target) device = { ...device, volume: target.volume } // put the real level back
        if (api.isNetworkError(e)) return fail(e)
        if (target) volumeRefused.add(target.id)
        const phone = target && (target.type === 'Smartphone' || target.type === 'Tablet')
        const note = phone
          ? `${target.name} sets its own volume — use the buttons on the device`
          : `${(target && target.name) || 'this device'} refused the volume command`
        say('volume', note)
        return failed('http', note)
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
      if (!d) return failed('http', 'that device is no longer listed')
      userPicked = true
      volumeRefused.delete(id) // give the new device its own chance
      device = d
      try {
        // `play: true` moves the stream to the new device without a gap.
        await api.transfer(d.id, true)
        clearTransient()
        return ok()
      } catch (e) {
        return fail(e)
      }
    },

    async poll() {
      try {
        const s = await api.state()
        authError = false
        clearTransient()
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
            message: notice.text || (started ? '' : 'ready'),
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
          message: notice.text,
          volume: device ? device.volume : null,
          volumeAvailable: !!(device && device.supportsVolume),
        })
      } catch (e) {
        if (api.isNetworkError(e)) {
          // We could not ask. Say only that — the engine keeps what it knew.
          say('network', OFFLINE_NOTE)
          return staleSnapshot(OFFLINE_NOTE)
        }
        const text = handleError(e)
        if (api.isAuthError(e) || e.status === 401) {
          return makeSnapshot({ authError: true, message: text })
        }
        // Spotify answered, and the answer was not about playback (rate limit,
        // a refused command). Nothing new is known about what is on air.
        return staleSnapshot(text)
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
