/* ----------------------------------------------------------------------------
   providers/spotify/auth.js — OAuth Authorization Code + PKCE, 100% client-side.

   No secret in the bundle, no backend: the app is a remote control for the
   user's own Spotify device. Ported from New Release Atlas.

   The redirect URI is derived from the deployment (`origin + BASE_URL`), so it
   MUST be registered in the Spotify app dashboard for this repo's Pages URL —
   see README, "Spotify setup". A different client id can be injected at build
   time with VITE_SPOTIFY_CLIENT_ID without touching the code.
   -------------------------------------------------------------------------- */

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}

export const CLIENT_ID = ENV.VITE_SPOTIFY_CLIENT_ID || '90be0fb998cf44b3b3b6560cfd52c5d5'

// user-read-currently-playing is what lets the radio notice that a track ended
// even when playback moved to another device.
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing'

export const REDIRECT_URI =
  typeof window !== 'undefined' ? window.location.origin + (ENV.BASE_URL || '/') : ''

const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'

const LS_TOKENS = 'nrr_sp_tokens'
const LS_VERIFIER = 'nrr_sp_verifier'
const LS_STATE = 'nrr_sp_state'

/* --- PKCE ---------------------------------------------------------------- */

function randomString(bytes) {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => ('0' + b.toString(16)).slice(-2)).join('')
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64url(digest)
}

/* --- tokens -------------------------------------------------------------- */

function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(LS_TOKENS) || 'null')
  } catch (e) {
    return null
  }
}

function writeTokens(t) {
  try {
    localStorage.setItem(LS_TOKENS, JSON.stringify(t))
  } catch (e) {
    /* private mode */
  }
}

export function isLoggedIn() {
  const t = readTokens()
  return !!(t && t.refresh_token)
}

export function logout() {
  try {
    localStorage.removeItem(LS_TOKENS)
  } catch (e) {
    /* noop */
  }
}

/* --- flow ---------------------------------------------------------------- */

export async function login() {
  const verifier = randomString(48) // 96 hex chars (valid range 43-128)
  const state = randomString(8)
  localStorage.setItem(LS_VERIFIER, verifier)
  localStorage.setItem(LS_STATE, state)
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await challenge(verifier),
    scope: SCOPES,
    state,
  })
  window.location.href = `${AUTH_URL}?${params.toString()}`
}

/**
 * Call once at startup: if we came back from the redirect, finish the exchange.
 * Always cleans the query string, success or not.
 *
 * It reports failures instead of swallowing them: an unregistered redirect URI
 * is THE most likely reason Connect never works on a new deployment, and it
 * arrives as `?error=…` with no code. Silently dropping that leaves the user
 * staring at a preview player with no idea why.
 *
 * @returns {Promise<{completed: boolean, error: string}>}
 */
export async function completeLoginIfNeeded() {
  const none = { completed: false, error: '' }
  if (typeof window === 'undefined') return none
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')
  const clean = () => {
    url.searchParams.delete('code')
    url.searchParams.delete('state')
    url.searchParams.delete('error')
    window.history.replaceState({}, '', url.toString())
  }
  if (denied) {
    clean()
    return { completed: false, error: denied }
  }
  if (!code) return none
  const expected = localStorage.getItem(LS_STATE)
  const verifier = localStorage.getItem(LS_VERIFIER)
  if (!verifier || (expected && state !== expected)) {
    clean()
    return { completed: false, error: 'state_mismatch' }
  }
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    })
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const j = await r.json()
    if (!r.ok || !j.access_token) {
      clean()
      return { completed: false, error: (j && j.error) || 'token_exchange_failed' }
    }
    writeTokens({
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      scope: j.scope || '',
    })
    localStorage.removeItem(LS_VERIFIER)
    localStorage.removeItem(LS_STATE)
    clean()
    return { completed: true, error: '' }
  } catch (e) {
    clean()
    return { completed: false, error: 'network' }
  }
}

/** Valid access token, refreshing when it is about to expire. */
export async function getValidToken() {
  const t = readTokens()
  if (!t || !t.access_token) return null
  if (Date.now() < (t.expires_at || 0) - 60000) return t.access_token
  if (!t.refresh_token) return null
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
    })
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const j = await r.json()
    if (!r.ok || !j.access_token) return null
    writeTokens({
      access_token: j.access_token,
      refresh_token: j.refresh_token || t.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      scope: j.scope || t.scope || '',
    })
    return j.access_token
  } catch (e) {
    return null
  }
}
