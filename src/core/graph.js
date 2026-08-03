/* ----------------------------------------------------------------------------
   core/graph.js — the archive, as the radio needs it.

   The radio consumes the SAME `graph.json` that New Release Atlas publishes
   (compact "format 2"): nodes are tracks, links carry their components in
   `c = [artist, primary, secondary, playlist]` and reference nodes by integer
   index. Nothing here draws anything — the radio only ever *walks* the graph.

   Two sources, in order:
     1. the live Atlas snapshot (remote, always current with the map);
     2. the vendored copy in `public/graph.json` (offline / PWA fallback).

   The loader also builds the read-only index the walker needs: id -> node,
   id -> neighbours (weight + components), genre buckets.
   -------------------------------------------------------------------------- */

// Guarded so this module also imports cleanly outside Vite (scripts/walk.mjs
// runs the walker in plain Node against the file on disk).
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}

// Where the live archive lives. Override at build time with VITE_GRAPH_URL,
// or at runtime with ?graph=<url> (handy for testing a candidate archive).
export const REMOTE_GRAPH_URL =
  ENV.VITE_GRAPH_URL || 'https://marcomauro.github.io/new-release-atlas/graph.json'

export const LOCAL_GRAPH_URL = `${ENV.BASE_URL || '/'}graph.json`

// Fallback used when the archive carries no meta.linkWeights (older files).
export const DEFAULT_LINK_WEIGHTS = { artist: 3.0, primary: 1.2, secondary: 0.6, playlist: 0.3 }

const TRACK_URL = (id) => `https://open.spotify.com/track/${id}`

/** Hydrate "format 2": index-based links -> ids, weight from components. */
export function hydrateGraph(raw) {
  const nodes = raw.nodes.map((n) => ({ ...n, url: n.url || TRACK_URL(n.id) }))
  const weights = { ...DEFAULT_LINK_WEIGHTS, ...((raw.meta && raw.meta.linkWeights) || {}) }
  const links = raw.links.map((l) => {
    const s = typeof l.source === 'number' ? nodes[l.source].id : l.source
    const t = typeof l.target === 'number' ? nodes[l.target].id : l.target
    const c = l.c || [0, 0, 0, 0]
    return { source: s, target: t, c, weight: l.weight != null ? l.weight : componentWeight(c, weights) }
  })
  return { nodes, links, genres: raw.genres || [], meta: { ...(raw.meta || {}), linkWeights: weights } }
}

export function componentWeight(c, w = DEFAULT_LINK_WEIGHTS) {
  return c[0] * w.artist + c[1] * w.primary + c[2] * w.secondary + c[3] * w.playlist
}

async function fetchJson(url, timeoutMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-cache' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Load the archive: remote first (so the radio follows the Atlas without a
 * redeploy), vendored copy as the fallback. Never throws when at least one of
 * the two answers.
 * @returns {Promise<{graph: object, index: object, source: 'remote'|'local', notice: string}>}
 */
export async function loadArchive({ remote, local = LOCAL_GRAPH_URL, timeoutMs = 5000 } = {}) {
  const override =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('graph') : null
  const remoteUrl = override || remote || REMOTE_GRAPH_URL
  const attempts = [
    { url: remoteUrl, source: 'remote' },
    { url: local, source: 'local' },
  ].filter((a, i, arr) => a.url && arr.findIndex((b) => b.url === a.url) === i)

  let lastErr = null
  for (const a of attempts) {
    try {
      const raw = await fetchJson(a.url, timeoutMs)
      if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length) throw new Error('empty archive')
      const graph = hydrateGraph(raw)
      return {
        graph,
        index: buildIndex(graph),
        source: a.source,
        notice:
          a.source === 'local' && lastErr
            ? 'live archive unreachable — using the bundled snapshot'
            : '',
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`no archive available (${lastErr ? lastErr.message : 'unknown error'})`)
}

/**
 * Read-only index over the graph. `neighbours` is sorted by descending weight,
 * which lets the walker cut the candidate pool cheaply.
 * Each neighbour entry: { id, w, c } — `c` is kept so rules (and the "why did
 * this play" caption) can tell a shared artist from a shared genre.
 */
export function buildIndex(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const neighbours = new Map(graph.nodes.map((n) => [n.id, []]))
  const merge = (a, b, w, c) => {
    const list = neighbours.get(a)
    if (!list) return
    const prev = list.find((e) => e.id === b)
    if (prev) {
      prev.w += w
      prev.c = prev.c.map((v, i) => v + c[i])
    } else {
      list.push({ id: b, w, c: [...c] })
    }
  }
  for (const l of graph.links) {
    if (!(l.weight > 0)) continue
    merge(l.source, l.target, l.weight, l.c)
    merge(l.target, l.source, l.weight, l.c)
  }
  for (const list of neighbours.values()) list.sort((x, y) => y.w - x.w)

  const byGenre = new Map()
  for (const n of graph.nodes) {
    const g = n.genre || 'unknown'
    if (!byGenre.has(g)) byGenre.set(g, [])
    byGenre.get(g).push(n)
  }
  for (const list of byGenre.values()) list.sort((a, b) => (b.degree || 0) - (a.degree || 0))

  const maxDegree = Math.max(1, ...graph.nodes.map((n) => n.degree || 0))
  const maxBpm = Math.max(1, ...graph.nodes.map((n) => n.bpm || 0))

  return {
    graph,
    nodes: graph.nodes,
    byId,
    neighbours,
    byGenre,
    maxDegree,
    maxBpm,
    genres: graph.genres,
    meta: graph.meta,
    node: (id) => byId.get(id) || null,
    neighboursOf: (id) => neighbours.get(id) || [],
  }
}

/** Loose search over title / artist / remixer — used by the seed picker. */
export function searchTracks(index, query, limit = 12) {
  const q = norm(query)
  if (q.length < 2) return []
  const hits = []
  for (const n of index.nodes) {
    const title = norm(n.title)
    const artists = norm((n.artists || [n.artist]).join(' '))
    let score = 0
    if (title.startsWith(q)) score = 5
    else if (title.includes(q)) score = 4
    else if (artists.startsWith(q)) score = 3
    else if (artists.includes(q)) score = 2
    if (!score) continue
    hits.push({ node: n, score: score + Math.min(0.9, (n.degree || 0) / index.maxDegree) })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit).map((h) => h.node)
}

export const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

/** Total archive listening time, for the "this station holds N hours" line. */
export function archiveDuration(index) {
  const sec = index.nodes.reduce((s, n) => s + (n.duration_sec || 0), 0)
  return { seconds: sec, hours: Math.round(sec / 3600) }
}
