/* ----------------------------------------------------------------------------
   providers/spotify/api.js — the slice of the Web API the radio needs.

   Note `queue()`: it is what makes the stream endless. The radio starts
   playback once and then appends one track at a time as the walk decides it,
   so playback is never restarted and there is no "playlist" anywhere.
   -------------------------------------------------------------------------- */

import { getValidToken } from './auth.js'

const API = 'https://api.spotify.com/v1'

/** @throws {{status:number, reason?:string, message?:string}} */
async function call(path, method = 'GET', body) {
  const token = await getValidToken()
  if (!token) throw { status: 401, reason: 'NO_AUTH' }
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (r.status === 204) return null
  let data = null
  try {
    data = await r.json()
  } catch (e) {
    /* empty body */
  }
  if (!r.ok) {
    throw {
      status: r.status,
      reason: data && data.error && data.error.reason,
      message: data && data.error && data.error.message,
    }
  }
  return data
}

export const devices = async () => ((await call('/me/player/devices')) || {}).devices || []
export const transfer = (deviceId, play = true) => call('/me/player', 'PUT', { device_ids: [deviceId], play })
export const play = (uris, deviceId) =>
  call('/me/player/play' + (deviceId ? `?device_id=${deviceId}` : ''), 'PUT', {
    uris,
    offset: { position: 0 },
  })
export const pause = () => call('/me/player/pause', 'PUT')
export const resume = () => call('/me/player/play', 'PUT')
export const seek = (ms) => call(`/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`, 'PUT')
export const state = () => call('/me/player')
export const next = () => call('/me/player/next', 'POST')
export const queue = (uri, deviceId) =>
  call(
    `/me/player/queue?uri=${encodeURIComponent(uri)}` + (deviceId ? `&device_id=${deviceId}` : ''),
    'POST'
  )
export const shuffle = (on) => call(`/me/player/shuffle?state=${on ? 'true' : 'false'}`, 'PUT')
export const repeat = (mode) => call(`/me/player/repeat?state=${mode}`, 'PUT')

/** Album art for up to 50 ids at once — authenticated, best quality. */
export async function tracksMeta(ids) {
  if (!ids.length) return []
  const d = await call(`/tracks?ids=${ids.slice(0, 50).join(',')}`)
  return (d && d.tracks) || []
}
