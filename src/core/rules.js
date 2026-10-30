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

  // Which kinds of link the walk follows, and how hard: the weight of a link is
  // Σ components × these numbers, exactly as the Atlas weighs it on the map.
  // null = the Atlas's own weights (graph.json meta.linkWeights), so the radio
  // walks the same graph the map draws. Only the ratios matter: affinity is
  // normalised per step. A kind set to 0 is not a path at all.
  links: null,

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
    // Any CREDITED artist (lead, featured, remixer): at most N of the last
    // `creditWindow` tracks. The two limits above see only the lead artist, so
    // a featured name could carry a run on its own — one artist on 9 tracks of
    // 10 was routine, through shared-artist links that were each legal.
    creditMaxInWindow: 3,
    creditWindow: 10,
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
    links: { artist: 4.5, primary: 1.5, secondary: 0.3, playlist: 0.1 },
    weights: { ...DEFAULT_RULESET.weights, affinity: 1.4, genreInertia: 0.6, freshness: 0.1, bridge: 0 },
    limits: { ...DEFAULT_RULESET.limits, artistGap: 6, artistMaxInWindow: 3, genreRunMax: 15 },
    targets: { ...DEFAULT_RULESET.targets, genreRun: 10 },
  },
  {
    ...DEFAULT_RULESET,
    id: 'drift',
    label: 'Drift',
    blurb: 'crosses the archive: bridges, new genres, wider jumps',
    window: 4,
    temperature: 0.45,
    links: { artist: 1.2, primary: 0.6, secondary: 1.2, playlist: 1.0 },
    weights: { ...DEFAULT_RULESET.weights, affinity: 0.7, genreInertia: 0.1, freshness: 0.6, bridge: 0.5, centrality: 0 },
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

/** The link kinds, in the order of a link's components `c`. */
export const LINK_KINDS = [
  { id: 'artist', label: 'Shared artist', describe: 'the two tracks share an artist (lead or featured)' },
  { id: 'primary', label: 'Same genre', describe: 'same primary genre' },
  { id: 'secondary', label: 'Shared genre', describe: 'a secondary genre in common — the way across genres' },
  { id: 'playlist', label: 'Same playlist', describe: 'released in the same New Release playlist' },
]

/**
 * After the walk has stayed `genreRun` tracks in one genre it starts to prefer
 * a change (genreInertia); this is where it is no longer allowed to stay. Tied
 * to the target so the one slider moves both — a cap of its own kept any
 * stretch above 6 out of reach, whatever the slider said.
 */
export const genreRunCapFor = (genreRun) => Math.max(genreRun + 1, Math.round(genreRun * 1.5))

/**
 * A ruleset as saved by an earlier session, laid over the preset it started
 * from: fields added since then get their defaults, and anything that is not a
 * number is dropped rather than trusted.
 */
export function normalizeRuleset(saved) {
  if (!saved || typeof saved !== 'object') return DEFAULT_RULESET
  const base = presetById(saved.id)
  const nums = (from, into) => {
    const out = { ...into }
    if (from && typeof from === 'object') {
      for (const k of Object.keys(into)) if (Number.isFinite(from[k])) out[k] = from[k]
    }
    return out
  }
  const top = nums(saved, { window: base.window, windowDecay: base.windowDecay, temperature: base.temperature, shortlist: base.shortlist })
  const linkBase = base.links || { artist: 0, primary: 0, secondary: 0, playlist: 0 }
  return {
    ...base,
    ...top,
    custom: saved.custom === true,
    links: saved.links && typeof saved.links === 'object' ? nums(saved.links, linkBase) : base.links,
    weights: nums(saved.weights, base.weights),
    limits: nums(saved.limits, base.limits),
    targets: nums(saved.targets, base.targets),
  }
}

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
    id: 'creditQuota',
    label: 'Credit spacing',
    describe: 'no credited artist (featured, remixer) on more than `creditMaxInWindow` of the last `creditWindow` tracks',
    test: (ctx, cand) => {
      const { creditMaxInWindow, creditWindow } = ctx.ruleset.limits
      if (!creditMaxInWindow || !ctx.creditHits) return true
      for (const a of cand.artists || [cand.artist]) {
        const at = ctx.creditHits.get(a)
        if (!at) continue
        let n = 0
        for (let i = at.length - 1; i >= 0 && ctx.position - at[i] <= creditWindow; i--) n++
        if (n >= creditMaxInWindow) return false
      }
      return true
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
    label: 'Exploration',
    describe:
      'pulls toward corners of the graph this session has not visited yet — tracks whose neighbours have not played',
    // "Not played yet" alone was a constant: noRepeat already keeps every
    // played track out for 120 steps, so every admissible candidate scored 1
    // and the slider did nothing for the first seven hours. What the walk can
    // actually choose between is how much of a candidate's neighbourhood it has
    // already been through.
    score: (ctx, cand) => {
      const at = ctx.lastPlayedAt.get(cand.id)
      const own = at == null ? 1 : clamp01((ctx.position - at) / Math.max(1, ctx.ruleset.limits.noRepeatWithin * 2))
      const nbs = ctx.index.neighboursOf(cand.id)
      if (!nbs.length) return own
      let seen = 0
      for (const nb of nbs) if (ctx.lastPlayedAt.has(nb.id)) seen++
      return own * (1 - seen / nbs.length)
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
      'tracks whose links lead out of their genre, but only when the walk is looking for a change of scene',
    // `bridging` is the share of a track's links that go to another primary
    // genre (Atlas build_graph.py). The boolean `is_bridge` is true for three
    // tracks in four, so it could not tell a gateway from anything else.
    score: (ctx, cand) => {
      const target = Math.max(1, ctx.ruleset.targets.genreRun)
      const wantChange = clamp01(ctx.genreRun / target)
      const isBridge =
        cand.bridging != null
          ? clamp01(cand.bridging / 0.6)
          : cand.is_bridge
            ? 1
            : clamp01(((cand.genre_count || 1) - 1) / 2)
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
