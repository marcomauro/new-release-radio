/* ----------------------------------------------------------------------------
   providers/index.js — the registry.

   The only file that knows which platforms exist. Adding one means writing a
   module that satisfies the contract in provider.js and listing it here; the
   radio picks it up (provider switch, capabilities, artwork) with no other
   change. See docs/PROVIDERS.md.
   -------------------------------------------------------------------------- */

import { createConnectProvider } from './spotify/connect.js'
import { createEmbedProvider } from './spotify/embed.js'
import { createSimulatedProvider } from './simulated.js'
import { isLoggedIn } from './spotify/auth.js'

export { CAPS } from './provider.js'

/** Instantiate every provider once, in preference order. */
export function createProviders() {
  return [createConnectProvider(), createEmbedProvider(), createSimulatedProvider()]
}

/**
 * Which provider should run on load: Connect when the user is already logged in
 * (full tracks are always the better radio), previews otherwise. `?player=<id>`
 * or a remembered choice win over both.
 */
export function preferredProviderId(providers, remembered) {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const asked = params && params.get('player')
  const has = (id) => providers.some((p) => p.id === id)
  if (asked && has(asked)) return asked
  if (remembered && has(remembered)) {
    // never resume into Connect after a logout
    if (remembered !== 'spotify-connect' || isLoggedIn()) return remembered
  }
  return isLoggedIn() ? 'spotify-connect' : 'spotify-embed'
}
