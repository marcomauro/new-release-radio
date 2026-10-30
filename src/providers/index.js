/* ----------------------------------------------------------------------------
   providers/index.js — the registry.

   The only file that knows which platforms exist. Adding one means writing a
   module that satisfies the contract in provider.js and listing it here; the
   radio picks it up (provider switch, capabilities, artwork, volume, outputs)
   with no other change. See docs/PROVIDERS.md.
   -------------------------------------------------------------------------- */

import { createConnectProvider } from './spotify/connect.js'
import { createYouTubeProvider } from './youtube.js'
import { isLoggedIn } from './spotify/auth.js'

export { CAPS } from './provider.js'

/** Instantiate every provider once, in preference order. */
export function createProviders() {
  return [createConnectProvider(), createYouTubeProvider()]
}

/**
 * Which provider runs on load.
 *
 * The rule that matters: **a live Spotify session outranks habit.** If there is
 * a token, the radio remote-controls Spotify; it must not stay on YouTube just
 * because YouTube is what played last time. That was a real bug (back when the
 * fallback was the 30-second preview player) — the remembered id was consulted
 * before the login state, so connecting Spotify left the radio where it was
 * until you switched the player by hand. Without a token, YouTube: whole
 * tracks, no login.
 *
 * Only two things outrank a live session:
 *   • `?player=<id>` in the URL — an explicit, per-visit instruction;
 *   • a provider the user picked BY HAND in the panel (`providerPinned`), because
 *     that is a decision rather than a leftover. Auto-selection never pins.
 *
 * @param {object[]} providers
 * @param {{providerId?: string, providerPinned?: boolean}} [saved] last session
 */
export function preferredProviderId(providers, saved) {
  const has = (id) => providers.some((p) => p.id === id)
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const asked = params && params.get('player')
  if (asked && has(asked)) return asked

  const loggedIn = isLoggedIn()
  const remembered = saved && saved.providerId
  if (saved && saved.providerPinned && has(remembered)) {
    // never resume into Connect without a token
    if (remembered !== 'spotify-connect' || loggedIn) return remembered
  }
  return loggedIn ? 'spotify-connect' : 'youtube'
}
