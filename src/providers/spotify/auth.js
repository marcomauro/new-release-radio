/* ----------------------------------------------------------------------------
   providers/spotify/auth.js — OAuth Authorization Code + PKCE, 100% client-side.

   No secret in the bundle, no backend: the app is a remote control for the
   user's own Spotify device. Ported from New Release Atlas.

   The redirect URI is derived from the deployment (`origin + BASE_URL`), so it
   MUST be registered in the Spotify app dashboard for this repo's Pages URL —
   see README, "Spotify setup". A different client id can be injected at build
   time with VITE_SPOTIFY_CLIENT_ID without touching the code.

   **"Could not ask" is not "was refused".** `acquireToken()` answers with a
   discriminated result, never a bare null: a token, a transient network
   failure, or a real rejection. Only the last one means the session is over.
   Collapsing the two used to tell a user on a flaky mobile connection that
   their session had expired — and hide the device picker — while the refresh
   token was perfectly valid.
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

// A token request that has not answered in this long will not answer at all.
// Without a deadline, a stalled mobile connection holds the whole radio: every
// Spotify call waits for a token first.
const TOKEN_TIMEOUT_MS = 8000

/** POST to the token endpoint with a deadline. Distinguishes silence from a no. */
async function postToken(body) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS) : null
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl ? ctrl.signal : undefined,
    })
    let data = null
    try {
      data = await r.json()
    } catch (e) {
      /* empty or truncated body */
    }
    return { ok: r.ok, status: r.status, data }
  } catch (e) {
    // Aborted by our own deadline, or the request never left the device: from
    // here the two are the same thing — no answer.
    return { ok: false, status: 0, data: null, network: true }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
  const res = await postToken(
    new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    })
  )
  const j = res.data
  if (res.network) {
    clean()
    return { completed: false, error: 'network' }
  }
  if (!res.ok || !j || !j.access_token) {
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
}

/* --- acquiring a token --------------------------------------------------- */

// One refresh at a time. Two concurrent refreshes are not just wasteful: Spotify
// may rotate the refresh token, so the second call can be spending a credential
// the first one has already replaced.
let refreshing = null

/**
 * A refusal from the token endpoint, told apart from a bad moment.
 * 5xx and 429 are the endpoint having a bad day; `invalid_grant` and friends are
 * the grant itself being dead, which is the only case that ends the session.
 */
function classifyRefusal(res) {
  if (res.network || res.status === 0) return 'network'
  if (res.status === 429 || res.status >= 500) return 'network'
  const code = (res.data && res.data.error) || ''
  if (code === 'server_error' || code === 'temporarily_unavailable') return 'network'
  return 'rejected'
}

async function doRefresh(t) {
  const res = await postToken(
    new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
    })
  )
  const j = res.data
  if (!res.ok || !j || !j.access_token) {
    const error = classifyRefusal(res)
    // Only a dead grant clears the credentials. A network failure must leave
    // them exactly where they are, so the next attempt can succeed.
    if (error === 'rejected') logout()
    return { error, detail: (j && j.error) || '' }
  }
  writeTokens({
    access_token: j.access_token,
    refresh_token: j.refresh_token || t.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope || t.scope || '',
  })
  return { token: j.access_token }
}

/**
 * A usable access token, or the reason there isn't one.
 *
 * @returns {Promise<{token?: string, error?: 'missing'|'network'|'rejected', detail?: string}>}
 *   `missing`  — nobody is connected (no tokens stored at all);
 *   `network`  — we could not ask; the session is presumed intact;
 *   `rejected` — Spotify refused the grant; the session is over.
 */
export async function acquireToken() {
  const t = readTokens()
  if (!t || !t.access_token) return { error: 'missing' }
  if (Date.now() < (t.expires_at || 0) - 60000) return { token: t.access_token }
  if (!t.refresh_token) return { error: 'missing' }
  if (refreshing) return refreshing
  refreshing = doRefresh(t).finally(() => {
    refreshing = null
  })
  return refreshing
}
