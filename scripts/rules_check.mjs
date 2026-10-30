#!/usr/bin/env node
/* ----------------------------------------------------------------------------
   rules_check.mjs — does every control in the panel actually move the walk?

   A slider that changes nothing is worse than no slider: it teaches the
   listener that the rules are decoration. Two of them were exactly that —
   "Freshness" was a constant for the first 120 steps (noRepeat had already
   removed everything it could have told apart) and "Genre stretch" stopped at 6
   whatever it said, behind a cap the panel did not show.

   So each control is turned from one end to the other on the same seeds, and
   the statistic it claims to drive must move the right way, by a margin. The
   walk is deterministic, so this is a test, not a sample.

     node scripts/rules_check.mjs            # assert
     node scripts/rules_check.mjs --table    # also print the numbers

   Runs on the vendored archive (public/graph.json), no browser.
   -------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { hydrateGraph, buildIndex } from '../src/core/graph.js'
import { createStation } from '../src/core/walker.js'
import { DEFAULT_RULESET, PRESETS, genreRunCapFor } from '../src/core/rules.js'

const here = dirname(fileURLToPath(import.meta.url))
const index = buildIndex(hydrateGraph(JSON.parse(readFileSync(resolve(here, '..', 'public/graph.json'), 'utf8'))))
const table = process.argv.includes('--table')

const SEEDS = index.nodes.filter((_, i) => i % 53 === 0).slice(0, 20)
const STEPS = 150
const MOOD = ['energy', 'valence', 'danceability', 'acousticness', 'instrumentalness']

/** Walk STEPS from every seed and measure what the controls claim to change. */
function measure(rs) {
  const m = { steps: 0, kinds: {}, genreChanges: 0, maxRun: 0, mood: 0, era: 0, degree: 0, bridging: 0, revisit: 0, back: 0, seedOk: 0, maxCredit: 0, relaxed: 0 }
  for (const seed of SEEDS) {
    const st = createStation({ index, ruleset: rs, seedNode: seed, lookahead: 1 })
    if (st.current && st.current.id === seed.id) m.seedOk++
    const seen = new Set([seed.id])
    const recent = [seed]
    let prev = seed
    let run = 1
    for (let i = 0; i < STEPS; i++) {
      const { node: n, why } = st.advance()
      m.kinds[why.kind] = (m.kinds[why.kind] || 0) + 1
      if (/ back$/.test(why.text)) m.back++
      if (why.relaxed) m.relaxed++
      // the most any one credited artist appears in the last ten tracks
      recent.push(n)
      if (recent.length > 10) recent.shift()
      const credits = new Map()
      for (const t of recent) for (const a of new Set(t.artists || [t.artist])) credits.set(a, (credits.get(a) || 0) + 1)
      m.maxCredit = Math.max(m.maxCredit, ...credits.values())
      if (n.genre !== prev.genre) {
        m.genreChanges++
        run = 1
      } else m.maxRun = Math.max(m.maxRun, ++run)
      m.mood += MOOD.reduce((s, d) => s + Math.abs((n[d] ?? 0.5) - (prev[d] ?? 0.5)), 0) / MOOD.length
      m.era += Math.abs((n.era_norm ?? 0.5) - (prev.era_norm ?? 0.5))
      m.degree += (n.degree || 0) / index.maxDegree
      m.bridging += n.bridging || 0
      const nbs = index.neighboursOf(n.id)
      m.revisit += nbs.filter((x) => seen.has(x.id)).length / Math.max(1, nbs.length)
      seen.add(n.id)
      prev = n
      m.steps++
    }
  }
  const per = (v) => v / m.steps
  return {
    artist: per(m.kinds.artist || 0),
    genre: per(m.kinds.genre || 0),
    genre2: per(m.kinds.genre2 || 0),
    playlist: per(m.kinds.playlist || 0),
    jump: per(m.kinds.jump || 0),
    back: per(m.back),
    genreChange: per(m.genreChanges),
    maxRun: m.maxRun,
    maxCredit: m.maxCredit,
    relaxed: per(m.relaxed),
    mood: per(m.mood),
    era: per(m.era),
    degree: per(m.degree),
    bridging: per(m.bridging),
    revisit: per(m.revisit),
    seedOk: m.seedOk / SEEDS.length,
  }
}

const D = DEFAULT_RULESET
const w = (id, v) => ({ ...D, weights: { ...D.weights, [id]: v } })
const links = (l) => ({ ...D, links: l })
const stretch = (g) => ({ ...D, targets: { ...D.targets, genreRun: g }, limits: { ...D.limits, genreRunMax: genreRunCapFor(g) } })

// [control, low ruleset, high ruleset, statistic, direction, minimum change]
const CASES = [
  ['Variety (temperature)', { ...D, temperature: 0 }, { ...D, temperature: 1 }, 'artist', -1, 0.08],
  ['Memory (window)', { ...D, window: 1 }, { ...D, window: 6 }, 'back', +1, 0.1],
  ['Genre stretch', stretch(1), stretch(14), 'genreChange', -1, 0.3],
  ['Genre stretch reaches long runs', stretch(4), stretch(14), 'maxRun', +1, 4],
  ['Link · shared artist', links({ artist: 0, primary: 1.2, secondary: 0.6, playlist: 0.3 }), links({ artist: 5, primary: 1.2, secondary: 0.6, playlist: 0.3 }), 'artist', +1, 0.4],
  ['Link · same genre', links({ artist: 3, primary: 0, secondary: 0.6, playlist: 0.3 }), links({ artist: 3, primary: 5, secondary: 0.6, playlist: 0.3 }), 'genre', +1, 0.2],
  ['Link · shared genre', links({ artist: 3, primary: 1.2, secondary: 0, playlist: 0.3 }), links({ artist: 3, primary: 1.2, secondary: 5, playlist: 0.3 }), 'genre2', +1, 0.2],
  ['Link · same playlist', links({ artist: 3, primary: 1.2, secondary: 0.6, playlist: 0 }), links({ artist: 3, primary: 1.2, secondary: 0.6, playlist: 5 }), 'playlist', +1, 0.2],
  ['Graph affinity', w('affinity', 0), w('affinity', 1.5), 'artist', +1, 0.2],
  ['Genre inertia', w('genreInertia', 0), w('genreInertia', 1.5), 'maxRun', -1, 1],
  ['Mood continuity', w('moodContinuity', 0), w('moodContinuity', 1.5), 'mood', -1, 0.02],
  ['Exploration', w('freshness', 0), w('freshness', 1.5), 'revisit', -1, 0.02],
  ['Centrality', w('centrality', 0), w('centrality', 1.5), 'degree', +1, 0.05],
  ['Bridge bonus', w('bridge', 0), w('bridge', 1.5), 'bridging', +1, 0.03],
  ['Era continuity', w('eraContinuity', 0), w('eraContinuity', 1.5), 'era', -1, 0.1],
]

let failed = 0
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(3))
for (const [name, lo, hi, stat, dir, min] of CASES) {
  const a = measure(lo)[stat]
  const b = measure(hi)[stat]
  const moved = (b - a) * dir
  const pass = moved >= min
  if (!pass) failed++
  console.log(`${pass ? '✓' : '✗'} ${name.padEnd(32)} ${stat.padEnd(12)} ${fmt(a).padStart(6)} → ${fmt(b).padStart(6)}${pass ? '' : `  (wanted ${dir > 0 ? '+' : '−'}${min})`}`)
}

// Every preset starts where it was asked to, stays on the graph, and keeps
// any one credited artist to its quota.
const byPreset = PRESETS.map((p) => [p, measure(p)])
for (const [p, s] of byPreset) {
  const quota = p.limits.creditMaxInWindow
  const ok = s.seedOk === 1 && s.jump < 0.02 && s.maxCredit <= quota && s.relaxed < 0.02
  if (!ok) failed++
  console.log(
    `${ok ? '✓' : '✗'} preset ${p.label.padEnd(25)} starts on its seed ${s.seedOk === 1 ? 'always' : `${(s.seedOk * 100).toFixed(0)}%`}` +
      ` · jumps ${(s.jump * 100).toFixed(1)}% · relaxed ${(s.relaxed * 100).toFixed(1)}% · one artist ≤ ${s.maxCredit} of 10 (quota ${quota})`
  )
}
if (table) {
  console.log('')
  for (const [p, s] of byPreset)
    console.log(p.id.padEnd(7), Object.entries(s).map(([k, v]) => `${k} ${fmt(v)}`).join(' · '))
}

console.log(failed ? `\n${failed} control(s) did not move the walk` : '\nevery control moves the walk')
process.exit(failed ? 1 : 0)
