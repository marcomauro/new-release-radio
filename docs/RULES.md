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
 (window, decay)    │ weighted by recency (windowDecay^k)        │
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

If **nothing** survives the filter in the neighbourhood, the same procedure runs
over the whole archive — that is a *jump*, and the UI labels it as one. If even
that fails (a very small archive, everything recently played), constraints are
dropped one at a time in this order: `artistQuota`, `genreRunCap`, `artistGap`,
`noRepeat`. Repeating a track is the last resort.

---

## The context

Every rule is a pure function of `(ctx, candidate)`. `candidate` is a graph node
(a track, exactly as it appears in `graph.json`). `ctx` is:

| field | type | meaning |
| --- | --- | --- |
| `index` | object | the archive index — `node(id)`, `neighboursOf(id)`, `byGenre`, `maxDegree`, `nodes` |
| `ruleset` | object | the ruleset in force (weights, limits, targets) |
| `current` | node \| null | what is playing now |
| `position` | number | the step number the candidate would occupy |
| `played` | string[] | ids in play order |
| `genreRun` | number | how many consecutive tracks are in `current.genre` |
| `lastPlayedAt` | Map id→step | when each track last played |
| `lastArtistAt` | Map artist→step | when each primary artist last played |
| `artistHits` | Map artist→step[] | every step per artist |
| `skips` | Map id→count | tracks the listener skipped |
| `artistSkips` | Map artist→count | artists the listener skipped |
| `affinity` | Map id→number | summed link weight from the recent window |
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
anything.

In the app, the **Dry run** player does the same thing with covers and captions,
at up to 120× speed.

---

## Presets

A preset is not code — it is the same rules with different numbers
(`PRESETS` in `rules.js`). Four ship today:

| preset | idea |
| --- | --- |
| **Flow** | the default: strong links, slow genre drift |
| **Deep dive** | stays in one corner, tolerates the same artists |
| **Drift** | crosses the archive, bridges, short genre stretches |
| **Smooth** | mood and tempo continuity above graph affinity |

When we define the real rules, most of the work should land as new scorers plus
new presets — the engine, the UI and the players should not need to know.
