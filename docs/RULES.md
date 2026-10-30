# The rules of the walk

The radio has no playlist. It has a **cursor on the graph** and a set of rules
that decide, one track at a time, where the cursor goes next. This document is
the contract for writing those rules — it is the file to read before touching
[`src/core/rules.js`](../src/core/rules.js).

The walker ([`src/core/walker.js`](../src/core/walker.js)) knows nothing about
music. It only knows how to:

1. collect candidates,
2. ask each **constraint** whether a candidate is allowed,
3. ask each **scorer** how much it likes a candidate,
4. sample from the best few.

So adding a rule never means touching the engine.

---

## One step, in order

```
                    ┌───────────────────────────────────────────┐
 last W played  ──► │ candidates = neighbours of the window,     │
 (window, decay)    │ link weight = Σ c[kind] × links[kind],     │
 links (per kind)   │ weighted by recency (windowDecay^k)        │
                    └───────────────────┬───────────────────────┘
                                        │  capped at limits.poolCap by affinity
                    ┌───────────────────▼───────────────────────┐
    CONSTRAINTS ──► │ hard filter: one false and it is out       │
                    └───────────────────┬───────────────────────┘
                                        │
       SCORERS   ──► │ total = Σ weight[id] × score(ctx, cand)   │
                    └───────────────────┬───────────────────────┘
                                        │  top `shortlist`
                    ┌───────────────────▼───────────────────────┐
                    │ sample ∝ exp(total / temperature)          │
                    └───────────────────────────────────────────┘
```

**Which links are paths.** A link of the Atlas graph carries its components
`c = [artist, primary, secondary, playlist]`. The walk weighs them with
`ruleset.links` — or, when that is `null` (the default, Flow and Smooth), with the
Atlas's own `meta.linkWeights`, so the radio walks the same graph the map draws.
A kind set to 0 is not a path at all: a link made only of that kind does not
enter the candidate pool. Deep dive leans on shared artists, Drift on shared
genres and playlists, which is what makes them cross the map differently. The
caption names the kind that carried the most weight under the rules in force.

If **nothing** survives the filter in the neighbourhood, the same procedure runs
over the whole archive — that is a *jump*, and the UI labels it as one. If even
that fails (a very small archive, everything recently played), constraints are
dropped one at a time in this order: `creditQuota`, `artistQuota`, `genreRunCap`,
`artistGap`, `noRepeat`. Repeating a track is the last resort.

---

## The context

Every rule is a pure function of `(ctx, candidate)`. `candidate` is a graph node
(a track, exactly as it appears in `graph.json`). `ctx` is:

| field | type | meaning |
| --- | --- | --- |
| `index` | object | the archive index — `node(id)`, `neighboursOf(id)`, `byGenre`, `maxDegree`, `nodes` |
| `ruleset` | object | the ruleset in force (links, weights, limits, targets) |
| `current` | node \| null | what is playing now |
| `position` | number | the step number the candidate would occupy |
| `played` | string[] | ids in play order |
| `genreRun` | number | how many consecutive tracks are in `current.genre` |
| `lastPlayedAt` | Map id→step | when each track last played |
| `lastArtistAt` | Map artist→step | when each primary artist last played |
| `artistHits` | Map artist→step[] | every step per primary artist |
| `creditHits` | Map artist→step[] | every step per credited artist (lead, featured, remixer) |
| `skips` | Map id→count | tracks the listener skipped |
| `artistSkips` | Map artist→count | artists the listener skipped |
| `affinity` | Map id→number | summed link weight from the recent window, under `ruleset.links` |
| `maxAffinity` | number | the largest value in `affinity`, for normalising |

`ctx` is rebuilt for every step and never mutated by a rule.

### Useful node fields

Straight from the Atlas archive: `genre`, `genres`, `artist`, `artists`,
`degree`, `bpm`, `duration_sec`, `playlists`, `era_norm`, `genre_count`,
`is_bridge`, `is_remix`, `is_instrumental`, `is_live`, `mood`, `subgenres`, and
the five mood parameters `energy`, `valence`, `danceability`, `acousticness`,
`instrumentalness` (0–1). Fields marked optional in the Atlas schema can be
missing — **always guard** (`if (cand.bpm == null) return 0.5`).

Neighbour entries are `{ id, w, c }` where `c = [artist, primary, secondary,
playlist]` are the link components: a rule can tell *why* two tracks are linked,
not just how strongly.

---

## Writing a constraint

```js
{
  id: 'noLiveAfterLive',
  label: 'No two live takes in a row',
  describe: 'shown in the panel under "always enforced"',
  test: (ctx, cand) => !(ctx.current && ctx.current.is_live && cand.is_live),
}
```

Rules of thumb:

- A constraint must be **cheap** — it runs on every candidate of every step.
- Never write a constraint that can reject *everything*; if it can, it belongs
  in `RELAX_ORDER` in the walker so the walk can still move.
- Anything you might want to soften later is a scorer, not a constraint.

## Writing a scorer

```js
{
  id: 'sameKey',
  label: 'Harmonic mixing',
  describe: 'prefers tracks in a compatible key',
  score: (ctx, cand) => (ctx.current && cand.camelot === ctx.current.camelot ? 1 : 0.3),
}
```

Then give it a default weight in `DEFAULT_RULESET.weights` (0 to ship it off by
default). It shows up in the panel automatically, with its `label` and
`describe` — the UI iterates over `SCORERS`, so there is no second list to keep
in sync.

Rules of thumb:

- Return a number in **[0, 1]**. The walker clamps, but a rule that saturates at
  1 everywhere is a rule that does nothing.
- Return `0.5`, not `0`, when the data is missing: `0` means "actively bad".
- Scores are combined **linearly**. If you need "A only when B", multiply inside
  one scorer (see `bridge`, which multiplies "is a bridge" by "wants a change").

---

## Tuning without a browser

```bash
node scripts/walk.mjs -n 200 --preset flow --explain
node scripts/walk.mjs -n 500 --stats-only --seed 58uRFOHOP3rnOgMqGnou91
```

`--explain` prints the per-rule contributions for each pick, so you can see
*which* rule chose a track. The tail summary is the honest measure of a ruleset:

```
played 400 · unique 324 · repeats 76
artists 239 · top: Nightmares On Wax ×7 · …
genres 11 · neo-soul ×101 · electronic ×50 · …
genre changes 174 · longest stretch 5 · tempo jumps >30bpm 1
```

A walk is reproducible: same seed + same preset + same archive = same sequence.
That is deliberate — a rule change that does not move these numbers did not do
anything. (In the app, each start from the panel gets a fresh seed, so starting
twice from the same track does not replay the same walk.)

## Every control must move the walk

```bash
node scripts/rules_check.mjs --table
```

turns every control in the panel from one end to the other on the same 20 seeds
and asserts that the statistic it claims to drive moves the right way, by a
margin: Variety → how often the strongest link wins, Memory → links taken from
further back, Genre stretch → genre changes and the longest run, each link kind
→ the share of steps taken over it, each scorer → its own quantity (mood
distance, era distance, degree, `bridging`, how much of a pick's neighbourhood
was already played). Two controls failed this when it was written:

- **Freshness** scored "not played yet" — but `noRepeat` already removes every
  track played in the last 120 steps, so every admissible candidate scored 1
  and the slider did nothing for seven hours of listening. It is now
  **Exploration**: the share of a candidate's neighbours not yet played, which
  pulls the walk toward corners of the map it has not been through.
- **Genre stretch** stopped at 6 whatever it said: `limits.genreRunMax` capped
  it and the panel did not show that limit. The slider now sets both
  (`genreRunCapFor`).

And one that worked on the wrong signal: **Bridge bonus** read `is_bridge`,
which is true for three tracks in four. It now reads `bridging`, the share of a
track's links that lead to another genre.

What the check cannot see: **Skip memory** needs skips (it is exercised in the
app), and **Tempo continuity** has little to work with — 761 of 1055 tracks have
no `bpm` in the archive, and a missing bpm scores a neutral 0.5. That is a data
gap in the Atlas, not a rule bug; filling it is what would make Smooth smooth.

## Tuning in the app

Everything in the **rules** tab is saved whole with the session, so a tuned path
survives a reload; it keeps its preset's name, marked *tuned* (and `*` on the
top bar chip), with a way back to the preset. On Spotify Connect, a change
lands after the track already handed to Spotify's queue: the API cannot take it
back, so the walk keeps it as its own next step instead of re-deciding it.

---

## Presets

A preset is not code — it is the same rules with different numbers
(`PRESETS` in `rules.js`), chosen in the **path** tab. Four ship today:

| preset | idea |
| --- | --- |
| **Flow** | the default: strong links, slow genre drift |
| **Deep dive** | stays in one corner, tolerates the same artists |
| **Drift** | crosses the archive, bridges, short genre stretches |
| **Smooth** | mood and tempo continuity above graph affinity |

When we define the real rules, most of the work should land as new scorers plus
new presets — the engine, the UI and the players should not need to know.
