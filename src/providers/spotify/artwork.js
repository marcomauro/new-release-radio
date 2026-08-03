/* ----------------------------------------------------------------------------
   providers/spotify/artwork.js — cover art, the one thing the radio shows.

   The archive carries no images (graph.json is metadata only), so covers are
   resolved lazily, per track, and cached in localStorage — a cover never
   changes, and the radio should not re-ask on every reload.

   Two paths:
   • authenticated → GET /tracks?ids=… batched, album.images, best quality;
   • anonymous     → the public oEmbed endpoint (no token, no scope), which
                     returns a 300px thumbnail. Spotify image ids encode the
                     size, so we optimistically ask for the 640px variant and
                     let the <img> fall back to the thumbnail if it 404s.
   -------------------------------------------------------------------------- */

import { tracksMeta } from './api.js'

const LS_KEY = 'nrr_covers_v1'
const MAX_CACHED = 600

const mem = new Map() // id -> { url, fallback }
let loaded = false
let saveTimer = null

function loadCache() {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    for (const [id, v] of Object.entries(raw)) if (v && v.url) mem.set(id, v)
  } catch (e) {
    /* ignore a corrupt cache */
  }
}

function persist() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const entries = [...mem.entries()].slice(-MAX_CACHED)
      localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch (e) {
      /* quota / private mode: the in-memory cache still works */
    }
  }, 800)
}

// 300px -> 640px variant of the same image (Spotify encodes the size in the id).
const upgrade = (url) => (url || '').replace('ab67616d00001e02', 'ab67616d0000b273')

function remember(id, url, fallback) {
  if (!id || !url) return null
  const entry = { url, fallback: fallback || url }
  mem.set(id, entry)
  persist()
  return entry
}

/* --- anonymous: oEmbed --------------------------------------------------- */

async function viaOEmbed(id) {
  const target = `https://open.spotify.com/track/${id}`
  const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`)
  if (!r.ok) throw new Error(`oembed ${r.status}`)
  const j = await r.json()
  if (!j || !j.thumbnail_url) throw new Error('oembed: no thumbnail')
  return remember(id, upgrade(j.thumbnail_url), j.thumbnail_url)
}

/* --- authenticated: batched /tracks ------------------------------------- */

let pending = new Map() // id -> [resolve]
let batchTimer = null

function flushBatch() {
  batchTimer = null
  const ids = [...pending.keys()].slice(0, 50)
  const waiting = pending
  pending = new Map()
  tracksMeta(ids)
    .then((tracks) => {
      for (const t of tracks || []) {
        const imgs = (t && t.album && t.album.images) || []
        const best = imgs[0] && imgs[0].url
        const small = (imgs[imgs.length - 1] && imgs[imgs.length - 1].url) || best
        if (t && t.id && best) remember(t.id, best, small)
      }
      for (const [id, resolvers] of waiting) resolvers.forEach((fn) => fn(mem.get(id) || null))
    })
    .catch(() => {
      // token died or rate limit: let each waiter retry anonymously
      for (const [id, resolvers] of waiting)
        viaOEmbed(id)
          .then((e) => resolvers.forEach((fn) => fn(e)))
          .catch(() => resolvers.forEach((fn) => fn(null)))
    })
}

function viaApi(id) {
  return new Promise((resolve) => {
    const list = pending.get(id) || []
    list.push(resolve)
    pending.set(id, list)
    if (!batchTimer) batchTimer = setTimeout(flushBatch, 60)
  })
}

/* --- public ------------------------------------------------------------- */

/**
 * @param {string} id  Spotify track id (= archive id)
 * @param {{authenticated?: boolean}} opts
 * @returns {Promise<{url: string, fallback: string}|null>}
 */
export async function coverFor(id, { authenticated = false } = {}) {
  loadCache()
  if (!id) return null
  const hit = mem.get(id)
  if (hit) return hit
  try {
    return authenticated ? await viaApi(id) : await viaOEmbed(id)
  } catch (e) {
    try {
      // one cross-path retry: whichever route failed, try the other
      return authenticated ? await viaOEmbed(id) : null
    } catch (e2) {
      return null
    }
  }
}

/** Warm the cache for the lookahead, so the next cover is already there. */
export function prefetchCovers(ids, opts) {
  loadCache()
  for (const id of ids || []) if (id && !mem.get(id)) coverFor(id, opts)
}

export const cachedCover = (id) => {
  loadCache()
  return mem.get(id) || null
}
