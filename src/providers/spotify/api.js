/* ----------------------------------------------------------------------------
   providers/spotify/api.js — the slice of the Web API the radio needs, and the
   only place that knows the network can fail.

   Note `queue()`: it is what makes the stream endless. The radio starts
   playback once and then appends one track at a time as the walk decides it,
   so playback is never restarted and there is no "playlist" anywhere.

   Everything above this file works with one error shape:

     { kind: 'network' | 'http' | 'auth', status, reason, message }

   `network` means **we never got an answer** — the request did not leave the
   device, or it did not come back before its deadline. That is a different fact
   from Spotify saying no, and the radio must treat it differently: a refusal
   changes what is true, silence only changes what we know.

   Three rules make the difference practical.

   • **A deadline on every request.** A mobile connection that has lost its
     bearer HANGS rather than failing; with no deadline a single request can
     wedge the polling loop for minutes and stay wedged after the signal is
     back.
   • **Retries per verb, not per call site.** Reads can be repeated freely.
     `queue` and `volume` can be repeated and reconciled. `next`, `play` and
     `seek` are never repeated automatically: a duplicate is audible, and a lost
     response is indistinguishable from a lost request.
   • **A budget.** Retries stop when the call has spent its overall time, so the
     engine above can rely on a bounded worst case.
   -------------------------------------------------------------------------- */

import { acquireToken } from './auth.js'

const API = 'https://api.spotify.com/v1'

export const NETWORK = 'network'
export const HTTP = 'http'
export const AUTH = 'auth'

export const isNetworkError = (e) => !!e && e.kind === NETWORK
export const isAuthError = (e) => !!e && e.kind === AUTH

/** Per-attempt deadline, and the overall budget for a call including retries. */
export const TIMEOUT_MS = { read: 6000, write: 8000 }
export const BUDGET_MS = { read: 12000, write: 14000, unsafe: 9000 }

/**
 * How many times a class of call may be attempted.
 *   read   — repeating is free
 *   write  — repeating is safe *because the result is reconciled* (queue, volume)
 *   unsafe — repeating would be heard (play, next, seek)
 */
const ATTEMPTS = { read: 3, write: 2, unsafe: 1 }
const BACKOFF_MS = 400

const netErr = (message, cause) => ({ kind: NETWORK, status: 0, reason: 'NETWORK', message, cause })
const authErr = (reason, message) => ({ kind: AUTH, status: 401, reason, message })

/** Only trusted when it says *offline*: browsers are optimistic about online. */
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Exponential with jitter, or whatever Spotify asked for on a 429. */
function backoffFor(attempt, e) {
  const after = e && e.retryAfter ? Number(e.retryAfter) * 1000 : 0
  if (after > 0) return Math.min(8000, after)
  const base = BACKOFF_MS * Math.pow(2, attempt)
  // Jitter: when a connection comes back, several endpoints recover at once and
  // should not all retry on the same millisecond.
  return base + Math.random() * base * 0.4
}

function retriable(e, policy) {
  if (isNetworkError(e)) return true
  if (!e || e.kind !== HTTP) return false
  if (e.status === 429) return true
  // A 5xx on a write may have been applied before it failed; only reads repeat.
  return e.status >= 500 && policy === 'read'
}

/** One attempt: token, request, deadline, and a typed error either way. */
async function attempt(path, method, body, timeoutMs) {
  const t = await acquireToken()
  if (t.error === 'network') throw netErr('could not reach Spotify to renew the session')
  if (!t.token) {
    throw authErr(
      t.error === 'rejected' ? 'TOKEN_REJECTED' : 'NO_AUTH',
      t.error === 'rejected' ? 'Spotify refused the session' : 'not connected to Spotify'
    )
  }

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  let r = null
  try {
    r = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${t.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store',
    })
  } catch (e) {
    const timedOut = !!(ctrl && ctrl.signal.aborted)
    throw netErr(
      timedOut ? 'Spotify did not answer in time' : 'the request never left the device',
      e
    )
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (r.status === 204) return null

  let raw = ''
  try {
    raw = await r.text()
  } catch (e) {
    // The body was cut off mid-flight. On a successful status that is still a
    // lost answer, not a Spotify decision.
    if (r.ok) throw netErr('the answer from Spotify was cut off', e)
  }
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch (e) {
    /* not JSON — leave it null and let the status speak */
  }

  if (r.ok) return data

  const err = data && data.error
  const reason = err && err.reason
  const message = err && err.message
  if (r.status === 401) throw authErr(reason || 'TOKEN_EXPIRED', message || 'the session was refused')
  throw {
    kind: HTTP,
    status: r.status,
    reason,
    message,
    retryAfter: r.headers && r.headers.get ? r.headers.get('Retry-After') : null,
  }
}

/**
 * @param {string} path
 * @param {{method?: string, body?: object, policy?: 'read'|'write'|'unsafe'}} [opts]
 * @throws {{kind: string, status: number, reason?: string, message?: string}}
 */
async function call(path, { method = 'GET', body, policy = 'read' } = {}) {
  const attempts = ATTEMPTS[policy] || 1
  const perTry = policy === 'read' ? TIMEOUT_MS.read : TIMEOUT_MS.write
  const deadline = Date.now() + (BUDGET_MS[policy] || BUDGET_MS.unsafe)

  for (let i = 0; ; i++) {
    // Asking a device that knows it is offline just burns the deadline.
    if (isOffline()) throw netErr('the device is offline')
    try {
      return await attempt(path, method, body, perTry)
    } catch (e) {
      const lastTry = i >= attempts - 1
      if (lastTry || !retriable(e, policy)) throw e
      const pause = backoffFor(i, e)
      if (Date.now() + pause >= deadline) throw e
      await wait(pause)
    }
  }
}

/* --- single-flight reads -------------------------------------------------- */

// The poll loop, the visibility resync and the device pill can all ask for the
// same thing within the same instant, and on a slow connection those overlap.
// One request, shared.
const inFlight = new Map()

function shared(key, fn) {
  const hit = inFlight.get(key)
  if (hit) return hit
  const p = fn().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

/* --- the endpoints -------------------------------------------------------- */

export const devices = () =>
  shared('devices', async () => ((await call('/me/player/devices')) || {}).devices || [])

export const state = () => shared('state', () => call('/me/player'))

/**
 * What Spotify itself says it will play next. This is the authority the radio
 * reconciles against: our own record of what we handed over can be wrong in
 * both directions after an outage (a command whose response was lost did land;
 * a command we believed landed did not).
 * @returns {Promise<{currently_playing: object|null, queue: object[]}>}
 */
export const queueState = () =>
  shared('queue', async () => (await call('/me/player/queue')) || { currently_playing: null, queue: [] })

export const transfer = (deviceId, play = true) =>
  call('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play }, policy: 'write' })

export const play = (uris, deviceId) =>
  call('/me/player/play' + (deviceId ? `?device_id=${deviceId}` : ''), {
    method: 'PUT',
    body: { uris, offset: { position: 0 } },
    policy: 'unsafe', // a repeat restarts the track
  })

export const pause = () => call('/me/player/pause', { method: 'PUT', policy: 'write' })
export const resume = () => call('/me/player/play', { method: 'PUT', policy: 'unsafe' })

export const seek = (ms) =>
  call(`/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`, {
    method: 'PUT',
    policy: 'unsafe', // a late repeat would seek whatever is playing by then
  })

export const next = () => call('/me/player/next', { method: 'POST', policy: 'unsafe' })

export const queue = (uri, deviceId) =>
  call(
    `/me/player/queue?uri=${encodeURIComponent(uri)}` + (deviceId ? `&device_id=${deviceId}` : ''),
    { method: 'POST', policy: 'write' } // a duplicate is visible in queueState()
  )

/** 0-100 on the given device. 403 = the device refuses remote volume. */
export const volume = (percent, deviceId) =>
  call(
    `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(percent)))}` +
      (deviceId ? `&device_id=${deviceId}` : ''),
    { method: 'PUT', policy: 'write' }
  )

export const shuffle = (on) =>
  call(`/me/player/shuffle?state=${on ? 'true' : 'false'}`, { method: 'PUT', policy: 'write' })

export const repeat = (mode) =>
  call(`/me/player/repeat?state=${mode}`, { method: 'PUT', policy: 'write' })

/** Album art for up to 50 ids at once — authenticated, best quality. */
export async function tracksMeta(ids) {
  if (!ids.length) return []
  const d = await call(`/tracks?ids=${ids.slice(0, 50).join(',')}`)
  return (d && d.tracks) || []
}
