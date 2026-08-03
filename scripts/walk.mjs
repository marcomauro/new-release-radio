#!/usr/bin/env node
/* ----------------------------------------------------------------------------
   walk.mjs — run the radio's walk in the terminal, with no browser and no
   streaming account. This is the tool for working on the rules: change
   src/core/rules.js, run this, read what the walk did.

     node scripts/walk.mjs                        40 steps, default station
     node scripts/walk.mjs -n 200 --preset drift
     node scripts/walk.mjs --seed 58uRFOHOP3rnOgMqGnou91 --explain   (--seed = a track id)
     node scripts/walk.mjs --stats-only -n 500

   Same seed + same preset + same archive = same walk, every time.
   -------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { hydrateGraph, buildIndex } from '../src/core/graph.js'
import { createStation, randomSeed } from '../src/core/walker.js'
import { presetById, PRESETS } from '../src/core/rules.js'

const here = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const short = process.argv.indexOf(`-${name[0]}`)
  if (name === 'n' && short >= 0) return process.argv[short + 1]
  return fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const steps = parseInt(arg('n', '40'), 10)
const graphPath = resolve(here, '..', arg('graph', 'public/graph.json'))
const preset = presetById(arg('preset', 'flow'))
const explain = flag('explain')
const statsOnly = flag('stats-only')

const raw = JSON.parse(readFileSync(graphPath, 'utf8'))
const index = buildIndex(hydrateGraph(raw))

const seedArg = arg('seed')
const seedNode = (seedArg && index.node(seedArg)) || randomSeed(index)
if (seedArg && !index.node(seedArg)) console.error(`! seed ${seedArg} not in the archive — picking one`)

const station = createStation({ index, ruleset: preset, seedNode })

console.log(
  `— ${index.meta.unique_tracks} tracks · ${index.meta.edges} links · station "${preset.label}" ` +
    `(${PRESETS.map((p) => p.id).join(', ')}) · seed ${seedNode.id}`
)
console.log('')

const played = [seedNode]
const printRow = (i, node, why) => {
  if (statsOnly) return
  const n = String(i).padStart(3, ' ')
  console.log(
    `${n}. ${node.title} — ${node.artist}\n     ${(node.genre || '?').padEnd(15)} ${
      node.bpm ? String(node.bpm).padStart(3) + ' bpm' : '       '
    }  ${why ? why.text : ''}`
  )
}
printRow(1, seedNode, station.currentWhy)

for (let i = 2; i <= steps; i++) {
  const step = station.advance()
  if (!step) {
    console.log('   (the walk ran out of admissible tracks)')
    break
  }
  played.push(step.node)
  printRow(i, step.node, step.why)
  if (explain && !statsOnly) {
    const parts = step.score.parts
      .filter((p) => p.contribution > 0.001)
      .map((p) => `${p.id} ${p.contribution.toFixed(2)}`)
      .join('  ')
    console.log(`     · ${parts}`)
  }
}

/* --- what the rules actually produced ------------------------------------ */

const uniq = new Set(played.map((n) => n.id))
const artists = new Map()
const genres = new Map()
let genreSwitches = 0
let maxRun = 0
let run = 1
let bpmJumps = 0
for (let i = 0; i < played.length; i++) {
  const n = played[i]
  artists.set(n.artist, (artists.get(n.artist) || 0) + 1)
  genres.set(n.genre, (genres.get(n.genre) || 0) + 1)
  if (i > 0) {
    if (played[i - 1].genre !== n.genre) {
      genreSwitches++
      maxRun = Math.max(maxRun, run)
      run = 1
    } else run++
    if (played[i - 1].bpm && n.bpm && Math.abs(played[i - 1].bpm - n.bpm) > 30) bpmJumps++
  }
}
maxRun = Math.max(maxRun, run)

const top = (m, k = 5) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([name, n]) => `${name} ×${n}`)
    .join(' · ')

console.log('')
console.log(`played ${played.length} · unique ${uniq.size} · repeats ${played.length - uniq.size}`)
console.log(`artists ${artists.size} · top: ${top(artists)}`)
console.log(`genres ${genres.size} · ${top(genres, 12)}`)
console.log(
  `genre changes ${genreSwitches} · longest stretch ${maxRun} · tempo jumps >30bpm ${bpmJumps}`
)
