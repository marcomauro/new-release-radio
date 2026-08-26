/* ----------------------------------------------------------------------------
   core/walker.js — the endless walk.

   A station is a cursor over the archive graph. It never builds a playlist:
   it holds the walk so far and produces the NEXT track on demand, so the
   stream has no end and no fixed length.

   One step:
     1. collect candidates = neighbours of the last `window` played tracks,
        each weighted by how recently it played (windowDecay);
     2. drop everything a CONSTRAINT rejects;
     3. score the survivors with the active SCORERS;
     4. sample from the shortlist with `temperature` (0 = always the best).
   When nothing survives (a corner of the graph is exhausted) the walk jumps:
   same procedure over the whole archive instead of the neighbourhood.

   State is a plain immutable-ish snapshot and the RNG is derived from
   (seed, step number), so the *same* state always produces the *same* next
   track. That is what makes the lookahead free — peeking N tracks ahead and
   then committing them one by one can never disagree with itself — and what
   makes a whole walk reproducible from a seed (scripts/walk.mjs).

   Rules live in core/rules.js. Nothing in here knows what a genre is.
   -------------------------------------------------------------------------- */

import { DEFAULT_RULESET, activeScorers, scoreCandidate, CONSTRAINTS } from './rules.js'

/* --- deterministic RNG ---------------------------------------------------- */

function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rngFor = (seed, step) => mulberry32((hashStr(String(seed)) ^ Math.imul(step + 1, 2654435761)) >>> 0)

/* --- state --------------------------------------------------------------- */

/**
 * @typedef {Object} WalkState
 * @property {string[]} played        ids in play order (last = playing now)
 * @property {Step[]}   steps         one entry per played track, why it played
 * @property {Map<string,number>} lastPlayedAt   id -> step it played at
 * @property {Map<string,number>} lastArtistAt   primary artist -> step
 * @property {Map<string,number[]>} artistHits   primary artist -> steps
 * @property {number} genreRun        consecutive tracks in the current genre
 * @property {Map<string,number>} skips        id -> times skipped
 * @property {Map<string,number>} artistSkips  artist -> times skipped
 */

function emptyState() {
  return {
    played: [],
    steps: [],
    lastPlayedAt: new Map(),
    lastArtistAt: new Map(),
    artistHits: new Map(),
    genreRun: 0,
    skips: new Map(),
    artistSkips: new Map(),
  }
}

function cloneState(s) {
  return {
    played: s.played.slice(),
    steps: s.steps.slice(),
    lastPlayedAt: new Map(s.lastPlayedAt),
    lastArtistAt: new Map(s.lastArtistAt),
    artistHits: new Map([...s.artistHits].map(([k, v]) => [k, v.slice()])),
    genreRun: s.genreRun,
    skips: new Map(s.skips),
    artistSkips: new Map(s.artistSkips),
  }
}

/** Append a played track to the state (pure: returns a new state). */
function commit(state, index, node, why) {
  const next = cloneState(state)
  const pos = next.played.length
  const prev = next.played.length ? index.node(next.played[next.played.length - 1]) : null
  next.played.push(node.id)
  next.steps.push({ id: node.id, why: why || { kind: 'seed', text: 'station seed' } })
  next.lastPlayedAt.set(node.id, pos)
  next.lastArtistAt.set(node.artist, pos)
  const hits = next.artistHits.get(node.artist) || []
  hits.push(pos)
  next.artistHits.set(node.artist, hits)
  next.genreRun = prev && prev.genre === node.genre ? next.genreRun + 1 : 1
  return next
}

/** Build the scoring context the rules see. Shape documented in docs/RULES.md. */
function makeContext(state, index, ruleset) {
  const current = state.played.length ? index.node(state.played[state.played.length - 1]) : null
  const position = state.played.length // step number the candidate would take
  const { affinity, maxAffinity } = windowAffinity(state, index, ruleset)
  return {
    index,
    ruleset,
    current,
    position,
    played: state.played,
    genreRun: state.genreRun,
    lastPlayedAt: state.lastPlayedAt,
    lastArtistAt: state.lastArtistAt,
    artistHits: state.artistHits,
    skips: state.skips,
    artistSkips: state.artistSkips,
    affinity,
    maxAffinity,
  }
}

/**
 * Affinity of every reachable track to the recent window: the sum of the link
 * weights from the last `window` played tracks, decayed by recency.
 */
function windowAffinity(state, index, ruleset) {
  const affinity = new Map()
  const w = Math.max(1, ruleset.window | 0)
  const decay = ruleset.windowDecay != null ? ruleset.windowDecay : 0.55
  let maxAffinity = 0
  for (let k = 0; k < w; k++) {
    const id = state.played[state.played.length - 1 - k]
    if (!id) break
    const factor = Math.pow(decay, k)
    for (const nb of index.neighboursOf(id)) {
      const v = (affinity.get(nb.id) || 0) + nb.w * factor
      affinity.set(nb.id, v)
      if (v > maxAffinity) maxAffinity = v
    }
  }
  return { affinity, maxAffinity }
}

/* --- why did this play --------------------------------------------------- */

const shared = (a = [], b = []) => a.filter((x) => b.includes(x))

/**
 * The human-readable reason for a transition — the one bit of the graph the UI
 * still shows, now as a caption instead of a drawing.
 *
 * The candidate pool comes from the whole recent window, so a track can arrive
 * on a link from two songs ago; the caption says so ("· 2 back") instead of
 * calling it a jump. A real jump is a step with no link at all, which only
 * happens when the neighbourhood is exhausted.
 */
function explainLink(index, windowNodes, to, topRule) {
  const from = windowNodes[0]
  if (!from) return { kind: 'seed', text: 'station seed', rule: null }
  let link = null
  let hops = 0
  for (let k = 0; k < windowNodes.length; k++) {
    const cand = index.neighboursOf(windowNodes[k].id).find((n) => n.id === to.id)
    if (cand) {
      link = cand
      hops = k
      break
    }
  }
  if (!link) return { kind: 'jump', text: 'jump across the archive', rule: topRule }
  const via = windowNodes[hops]
  const tail = hops ? ` · ${hops + 1} back` : ''
  const [artist, primary, secondary, playlist] = link.c
  if (artist > 0) {
    const names = shared(via.artists || [via.artist], to.artists || [to.artist])
    return {
      kind: 'artist',
      text: (names.length ? `shared artist · ${names[0]}` : 'shared artist') + tail,
      rule: topRule,
    }
  }
  if (primary > 0) return { kind: 'genre', text: `same genre · ${to.genre}${tail}`, rule: topRule }
  if (secondary > 0) {
    const g = shared(via.genres || [], to.genres || [])
    return {
      kind: 'genre2',
      text: (g.length ? `shared genre · ${g[0]}` : 'shared genre') + tail,
      rule: topRule,
    }
  }
  if (playlist > 0) {
    const p = shared(via.playlists || [], to.playlists || [])
    return {
      kind: 'playlist',
      text: (p.length ? `same playlist · #${p[0]}` : 'same playlist') + tail,
      rule: topRule,
    }
  }
  return { kind: 'link', text: `graph link${tail}`, rule: topRule }
}

/* --- one step ------------------------------------------------------------ */

function sample(shortlist, temperature, rnd) {
  if (!shortlist.length) return null
  if (!(temperature > 0.001) || shortlist.length === 1) return shortlist[0]
  const top = shortlist[0].score.total
  const weights = shortlist.map((c) => Math.exp((c.score.total - top) / temperature))
  const sum = weights.reduce((a, b) => a + b, 0)
  let r = rnd() * sum
  for (let i = 0; i < shortlist.length; i++) {
    r -= weights[i]
    if (r <= 0) return shortlist[i]
  }
  return shortlist[shortlist.length - 1]
}

// Constraints are dropped in this order when a step would otherwise be
// impossible (tiny archive, every neighbour already played, …). `noRepeat` is
// the last to go: repeating a track is the worst outcome for a radio.
const RELAX_ORDER = ['artistQuota', 'genreRunCap', 'artistGap', 'noRepeat']

function admissible(ctx, cand, dropped) {
  for (const c of CONSTRAINTS) {
    if (dropped.has(c.id)) continue
    if (!c.test(ctx, cand)) return false
  }
  return true
}

/**
 * Pure step: given a state, return the chosen track and the state that
 * includes it. Never returns null unless the archive itself is empty.
 * @returns {{step: Step, state: WalkState}|null}
 */
export function nextStep(state, index, ruleset, seed) {
  if (!index.nodes.length) return null
  const ctx = makeContext(state, index, ruleset)
  const scorers = activeScorers(ruleset)
  const rnd = rngFor(seed, state.played.length)
  const dropped = new Set()

  for (let relax = 0; relax <= RELAX_ORDER.length; relax++) {
    // 1. neighbourhood first, whole archive as the fallback (a "jump")
    const pools = [neighbourPool(ctx, index, ruleset), null]
    for (const pool of pools) {
      const candidates = pool || index.nodes
      const scored = []
      for (const cand of candidates) {
        if (!admissible(ctx, cand, dropped)) continue
        scored.push({ node: cand, score: scoreCandidate(ctx, cand, scorers) })
      }
      if (!scored.length) continue
      scored.sort((a, b) => b.score.total - a.score.total)
      const shortlist = scored.slice(0, Math.max(1, ruleset.shortlist | 0 || 8))
      const picked = sample(shortlist, ruleset.temperature, rnd)
      const topRule = picked.score.parts.length ? picked.score.parts[0].id : null
      const why = explainLink(index, windowNodes(state, index, ruleset), picked.node, topRule)
      if (relax) why.relaxed = [...dropped]
      const step = {
        id: picked.node.id,
        node: picked.node,
        why,
        score: picked.score,
        alternatives: shortlist.slice(0, 5).map((c) => ({ id: c.node.id, total: c.score.total })),
      }
      return { step, state: commit(state, index, picked.node, why) }
    }
    if (relax < RELAX_ORDER.length) dropped.add(RELAX_ORDER[relax])
  }
  return null
}

/** The tracks whose links seeded the candidate pool, newest first. */
function windowNodes(state, index, ruleset) {
  const w = Math.max(1, ruleset.window | 0)
  const out = []
  for (let k = 0; k < w; k++) {
    const id = state.played[state.played.length - 1 - k]
    if (!id) break
    const n = index.node(id)
    if (n) out.push(n)
  }
  return out
}

/** Candidate pool from the recent window, capped by affinity for speed. */
function neighbourPool(ctx, index, ruleset) {
  const cap = Math.max(20, ruleset.limits.poolCap | 0 || 320)
  const ids = [...ctx.affinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap)
  const pool = []
  for (const [id] of ids) {
    const n = index.node(id)
    if (n) pool.push(n)
  }
  return pool
}

/* --- station ------------------------------------------------------------- */

/**
 * A live station: the walk so far, a lookahead, and the actions the player
 * needs. Mutable on the outside (it is a cursor), pure on the inside.
 *
 * @param {object}  opts.index      archive index (core/graph.js)
 * @param {object}  opts.ruleset    core/rules.js ruleset
 * @param {object}  opts.seedNode   first track
 * @param {string}  opts.seed       RNG seed — same seed = same walk
 * @param {number}  opts.lookahead  how many tracks to keep queued
 */
export function createStation({ index, ruleset = DEFAULT_RULESET, seedNode, seed, lookahead = 2 }) {
  let rules = ruleset
  let rngSeed = seed || (seedNode ? seedNode.id : 'radio')
  let state = emptyState()
  let queue = [] // [{ step, state }] — provisional, already-decided future
  const listeners = new Set()

  const emit = () => listeners.forEach((fn) => fn())

  const start = (node) => {
    state = commit(emptyState(), index, node, { kind: 'seed', text: 'station seed', rule: null })
    queue = []
    fill()
  }

  function fill() {
    while (queue.length < lookahead) {
      const from = queue.length ? queue[queue.length - 1].state : state
      const r = nextStep(from, index, rules, rngSeed)
      if (!r) break
      queue.push(r)
    }
  }

  if (seedNode) start(seedNode)

  const currentNode = () => (state.played.length ? index.node(state.played[state.played.length - 1]) : null)
  const currentStep = () => (state.steps.length ? state.steps[state.steps.length - 1] : null)

  return {
    /* --- reads --- */
    get ruleset() {
      return rules
    },
    get seed() {
      return rngSeed
    },
    get current() {
      return currentNode()
    },
    get currentWhy() {
      const s = currentStep()
      return s ? s.why : null
    },
    get position() {
      return Math.max(0, state.played.length - 1)
    },
    /** Tracks already played, newest first (excluding the current one). */
    history(n = 20) {
      const out = []
      for (let i = state.played.length - 2; i >= 0 && out.length < n; i--) {
        const node = index.node(state.played[i])
        if (node) out.push({ node, why: state.steps[i] ? state.steps[i].why : null })
      }
      return out
    },
    /** The decided-but-not-yet-played tracks. */
    upNext(n = 2) {
      fill()
      return queue.slice(0, n).map((q) => ({ node: q.step.node, why: q.step.why, score: q.step.score }))
    },

    /* --- moves --- */
    /** Commit the next queued track. Returns the new current step. */
    advance() {
      fill()
      const head = queue.shift()
      if (!head) return null
      state = head.state
      fill()
      emit()
      return head.step
    },
    /**
     * Record that the user pushed the current track away, so the skip rules can
     * see it. `rebuild` re-decides the lookahead with that knowledge — right for
     * a provider we drive track by track, wrong for one whose queue we have
     * already handed the next track to (it would disagree with what will
     * actually play; the poll reconciles instead).
     */
    noteSkip(rebuild = false) {
      const cur = currentNode()
      if (!cur) return
      const s = cloneState(state)
      s.skips.set(cur.id, (s.skips.get(cur.id) || 0) + 1)
      s.artistSkips.set(cur.artist, (s.artistSkips.get(cur.artist) || 0) + 1)
      state = s
      if (rebuild) queue = []
      fill()
    },
    /** Same as advance(), but remembers that the user pushed the track away. */
    skip() {
      this.noteSkip(true)
      return this.advance()
    },
    /**
     * Jump the walk onto a specific track (search result, history click), or
     * onto whatever the platform decided to play (`kind: 'device'`).
     *
     * The caption says which it was. It used to read "restart" for the device
     * case, which was both wrong and alarming: nothing had restarted — the walk
     * had followed the player somewhere it did not choose, and that is the one
     * thing the line needs to admit.
     */
    jumpTo(id, kind = 'manual') {
      const node = index.node(id)
      if (!node) return null
      const text = kind === 'manual' ? 'picked by hand' : 'followed your player'
      state = commit(state, index, node, { kind, text, rule: null })
      queue = []
      fill()
      emit()
      return currentStep()
    },
    /** Restart the station from a new seed, forgetting the walk. */
    reseed(node, newSeed) {
      if (!node) return null
      rngSeed = newSeed || node.id
      start(node)
      emit()
      return currentStep()
    },
    /** Swap the rules mid-stream: the current track keeps playing, the future is re-decided. */
    setRuleset(next) {
      rules = next || DEFAULT_RULESET
      queue = []
      fill()
      emit()
    },

    /* --- persistence: resume the same station after a reload --- */
    serialize() {
      return {
        v: 2,
        seed: rngSeed,
        rulesetId: rules.id,
        played: state.played.slice(-200),
        // the reasons too, so a resumed session keeps its captions
        steps: state.steps.slice(-200),
        skips: [...state.skips.entries()],
        artistSkips: [...state.artistSkips.entries()],
      }
    },
    restore(saved) {
      if (!saved || !Array.isArray(saved.played) || !saved.played.length) return false
      let s = emptyState()
      const steps = Array.isArray(saved.steps) ? saved.steps : []
      saved.played.forEach((id, i) => {
        const node = index.node(id)
        if (!node) return
        const step = steps[i] && steps[i].id === id ? steps[i] : null
        s = commit(s, index, node, (step && step.why) || { kind: 'resume', text: 'resumed', rule: null })
      })
      if (!s.played.length) return false
      s.skips = new Map(saved.skips || [])
      s.artistSkips = new Map(saved.artistSkips || [])
      state = s
      rngSeed = saved.seed || rngSeed
      queue = []
      fill()
      emit()
      return true
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

/** Pick a plausible opening track: well connected, but not always the same one. */
export function randomSeed(index, rnd = Math.random) {
  const pool = index.nodes.filter((n) => (n.degree || 0) >= index.maxDegree * 0.15)
  const list = pool.length ? pool : index.nodes
  return list[Math.floor(rnd() * list.length)]
}
