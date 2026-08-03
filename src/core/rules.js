/* ----------------------------------------------------------------------------
   core/rules.js — the rules of the walk.

   THIS IS THE FILE TO EDIT when we define the real playback rules. The walker
   (core/walker.js) knows nothing about music: it collects candidates, asks
   every CONSTRAINT whether a candidate is admissible, asks every SCORER how
   much it likes it, and samples from the result. Adding a rule = adding an
   entry here; nothing else in the app needs to change.

   Two kinds of rule:

   • CONSTRAINT — a hard yes/no. `test(ctx, cand) -> boolean`. A single false
     drops the candidate. Use for "never do this" (repeats, artist too close).

   • SCORER — a soft preference. `score(ctx, cand) -> number in [0,1]`, combined
     linearly with the weight in `ruleset.weights[id]`. Weight 0 disables it,
     which is how the UI turns rules off without deleting them.

   Everything is a pure function of (ctx, candidate), so a walk is reproducible:
   same seed + same ruleset + same archive = same sequence (see scripts/walk.mjs).

   Full contract, with the exact shape of `ctx`, in docs/RULES.md.
   -------------------------------------------------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const MOOD_DIMS = ['energy', 'valence', 'danceability', 'acousticness', 'instrumentalness']

/* ===========================================================================
   Rulesets — the tunable numbers, kept apart from the rule logic.
   =========================================================================== */

export const DEFAULT_RULESET = {
  id: 'flow',
  label: 'Flow',
  blurb: 'follows the strongest links, drifts genre slowly',

  // How many recently played tracks seed the candidate pool, and how fast
  // their pull decays (1, decay, decay², …). 1 = strict chain, >1 = the walk
  // remembers where it just was.
  window: 3,
  windowDecay: 0.55,

  // Sampling: 0 = always the best candidate (deterministic and repetitive),
  // higher = more surprise. Applied to the top `shortlist` candidates.
  temperature: 0.22,
  shortlist: 10,

  weights: {
    affinity: 1.0,
    genreInertia: 0.35,
    moodContinuity: 0.3,
    bpmContinuity: 0.2,
    freshness: 0.25,
    skipMemory: 0.25,
    centrality: 0.1,
    bridge: 0.15,
    eraContinuity: 0.05,
  },

  limits: {
    noRepeatWithin: 120, // never replay a track within N steps (~7 h of listening)
    artistGap: 12, // same primary artist: at least N steps apart
    artistMaxInWindow: 2, // …and at most N times in the last `artistWindow`
    artistWindow: 40,
    genreRunMax: 6, // after N tracks in a row in one genre, force a change
    poolCap: 320, // candidates scored per step (perf guard)
  },

  targets: {
    genreRun: 4, // preferred length of a genre stretch
    bpmTolerance: 14, // ± bpm that still counts as "continuous"
  },
}

/** Station presets = the same rules, different numbers. */
export const PRESETS = [
  DEFAULT_RULESET,
  {
    ...DEFAULT_RULESET,
    id: 'deep',
    label: 'Deep dive',
    blurb: 'stays close: same artists, same corner of the archive',
    window: 2,
    temperature: 0.12,
    weights: { ...DEFAULT_RULESET.weights, affinity: 1.4, genreInertia: 0.6, freshness: 0.1, bridge: 0 },
    limits: { ...DEFAULT_RULESET.limits, artistGap: 6, artistMaxInWindow: 3, genreRunMax: 12 },
    targets: { ...DEFAULT_RULESET.targets, genreRun: 10 },
  },
  {
    ...DEFAULT_RULESET,
    id: 'drift',
    label: 'Drift',
    blurb: 'crosses the archive: bridges, new genres, wider jumps',
    window: 4,
    temperature: 0.45,
    weights: { ...DEFAULT_RULESET.weights, affinity: 0.7, genreInertia: 0.1, freshness: 0.5, bridge: 0.5, centrality: 0 },
    limits: { ...DEFAULT_RULESET.limits, artistGap: 20, genreRunMax: 3 },
    targets: { ...DEFAULT_RULESET.targets, genreRun: 2 },
  },
  {
    ...DEFAULT_RULESET,
    id: 'smooth',
    label: 'Smooth',
    blurb: 'mood and tempo first: no jolts between tracks',
    temperature: 0.18,
    weights: {
      ...DEFAULT_RULESET.weights,
      affinity: 0.6,
      moodContinuity: 0.9,
      bpmContinuity: 0.7,
      genreInertia: 0.4,
      bridge: 0.05,
    },
  },
]

export const presetById = (id) => PRESETS.find((p) => p.id === id) || DEFAULT_RULESET

/* ===========================================================================
   CONSTRAINTS — hard admissibility
   =========================================================================== */

export const CONSTRAINTS = [
  {
    id: 'notPlaying',
    label: 'Not the current track',
    describe: 'a track never follows itself',
    test: (ctx, cand) => !ctx.current || cand.id !== ctx.current.id,
  },
  {
    id: 'noRepeat',
    label: 'No repeats',
    describe: 'a track cannot come back within `noRepeatWithin` steps',
    test: (ctx, cand) => {
      const at = ctx.lastPlayedAt.get(cand.id)
      return at == null || ctx.position - at > ctx.ruleset.limits.noRepeatWithin
    },
  },
  {
    id: 'artistGap',
    label: 'Artist spacing',
    describe: 'the same primary artist needs `artistGap` steps of distance',
    test: (ctx, cand) => {
      const at = ctx.lastArtistAt.get(cand.artist)
      return at == null || ctx.position - at > ctx.ruleset.limits.artistGap
    },
  },
  {
    id: 'artistQuota',
    label: 'Artist quota',
    describe: 'at most `artistMaxInWindow` tracks per artist in the recent window',
    test: (ctx, cand) => {
      const { artistMaxInWindow, artistWindow } = ctx.ruleset.limits
      const at = ctx.artistHits.get(cand.artist)
      if (!at) return true
      let n = 0
      for (const pos of at) if (ctx.position - pos <= artistWindow) n++
      return n < artistMaxInWindow
    },
  },
  {
    id: 'genreRunCap',
    label: 'Genre run cap',
    describe: 'after `genreRunMax` tracks in one genre, the next must change genre',
    test: (ctx, cand) => {
      const { genreRunMax } = ctx.ruleset.limits
      if (!ctx.current || ctx.genreRun < genreRunMax) return true
      return cand.genre !== ctx.current.genre
    },
  },
]

/* ===========================================================================
   SCORERS — soft preferences, each normalised to [0,1]
   =========================================================================== */

export const SCORERS = [
  {
    id: 'affinity',
    label: 'Graph affinity',
    describe: 'pull of the weighted links from the recent window — the core of the walk',
    score: (ctx, cand) => (ctx.maxAffinity > 0 ? (ctx.affinity.get(cand.id) || 0) / ctx.maxAffinity : 0),
  },
  {
    id: 'genreInertia',
    label: 'Genre inertia',
    describe:
      'holds the current genre for about `targets.genreRun` tracks, then starts to prefer a change',
    score: (ctx, cand) => {
      if (!ctx.current) return 0.5
      const same = cand.genre === ctx.current.genre
      const target = Math.max(1, ctx.ruleset.targets.genreRun)
      const wantChange = clamp01(ctx.genreRun / target) // 0 → keep going, 1 → time to move
      return same ? 1 - wantChange : wantChange
    },
  },
  {
    id: 'moodContinuity',
    label: 'Mood continuity',
    describe: 'closeness in the 5 mood parameters (energy, valence, danceability, …)',
    score: (ctx, cand) => {
      if (!ctx.current) return 0.5
      let sum = 0
      let k = 0
      for (const d of MOOD_DIMS) {
        const a = ctx.current[d]
        const b = cand[d]
        if (a == null || b == null) continue
        sum += 1 - Math.abs(a - b)
        k++
      }
      return k ? sum / k : 0.5
    },
  },
  {
    id: 'bpmContinuity',
    label: 'Tempo continuity',
    describe: 'gaussian around the current bpm; half/double tempo counts as a match',
    score: (ctx, cand) => {
      const a = ctx.current && ctx.current.bpm
      const b = cand.bpm
      if (!a || !b) return 0.5
      const tol = Math.max(2, ctx.ruleset.targets.bpmTolerance)
      const d = Math.min(Math.abs(a - b), Math.abs(a - b * 2), Math.abs(a - b / 2))
      return Math.exp(-(d * d) / (2 * tol * tol))
    },
  },
  {
    id: 'freshness',
    label: 'Freshness',
    describe: 'favours what this session has not played yet (and long-ago plays over recent ones)',
    score: (ctx, cand) => {
      const at = ctx.lastPlayedAt.get(cand.id)
      if (at == null) return 1
      const age = ctx.position - at
      return clamp01(age / Math.max(1, ctx.ruleset.limits.noRepeatWithin * 2))
    },
  },
  {
    id: 'skipMemory',
    label: 'Skip memory',
    describe:
      'what you skipped does not come straight back, and its artist loses a little pull',
    score: (ctx, cand) => {
      const own = ctx.skips.get(cand.id) || 0
      if (own) return 0
      const byArtist = ctx.artistSkips.get(cand.artist) || 0
      return clamp01(1 - 0.4 * byArtist)
    },
  },
  {
    id: 'centrality',
    label: 'Centrality',
    describe: 'mild pull toward well-connected tracks — keeps the stream on the archive’s spine',
    score: (ctx, cand) => clamp01((cand.degree || 0) / ctx.index.maxDegree),
  },
  {
    id: 'bridge',
    label: 'Bridge bonus',
    describe:
      'multi-genre / bridge tracks, but only when the station is looking for a change of scene',
    score: (ctx, cand) => {
      const target = Math.max(1, ctx.ruleset.targets.genreRun)
      const wantChange = clamp01(ctx.genreRun / target)
      const isBridge = cand.is_bridge ? 1 : clamp01(((cand.genre_count || 1) - 1) / 2)
      return isBridge * wantChange
    },
  },
  {
    id: 'eraContinuity',
    label: 'Era continuity',
    describe: 'keeps neighbouring playlists (archive era) close together',
    score: (ctx, cand) => {
      if (!ctx.current || ctx.current.era_norm == null || cand.era_norm == null) return 0.5
      return 1 - Math.abs(ctx.current.era_norm - cand.era_norm)
    },
  },
]

export const SCORER_BY_ID = new Map(SCORERS.map((s) => [s.id, s]))
export const CONSTRAINT_BY_ID = new Map(CONSTRAINTS.map((c) => [c.id, c]))

/** Active scorers for a ruleset (weight > 0), resolved once per step. */
export function activeScorers(ruleset) {
  return SCORERS.map((s) => ({ rule: s, weight: ruleset.weights[s.id] || 0 })).filter((s) => s.weight > 0)
}

/**
 * Score one candidate. Returns the total plus the per-rule breakdown, which the
 * UI uses to explain a pick and scripts/walk.mjs prints when tuning rules.
 */
export function scoreCandidate(ctx, cand, scorers) {
  let total = 0
  const parts = []
  for (const { rule, weight } of scorers) {
    const raw = clamp01(rule.score(ctx, cand))
    const contribution = raw * weight
    total += contribution
    parts.push({ id: rule.id, raw, weight, contribution })
  }
  parts.sort((a, b) => b.contribution - a.contribution)
  return { total, parts }
}

/** First failing constraint, or null when the candidate is admissible. */
export function rejectedBy(ctx, cand) {
  for (const c of CONSTRAINTS) if (!c.test(ctx, cand)) return c
  return null
}
