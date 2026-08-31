# New Release Radio

An **endless radio** over the [New Release Atlas](https://marcomauro.github.io/new-release-atlas/)
archive. It starts from one track and keeps walking the music graph — shared
artist, shared genre, same playlist — deciding the next track one step at a
time. No playlist, no end: a station that plays the archive the way it is
actually connected.

The map is the other project. Here there is **no graph on screen**: just the
cover of what is playing, its title, and one line saying why the walk chose it.

Archive: **873 tracks · 7667 links · 12 genres** (playlists #1–#39 + 1 extra, updated 2026-07-26).

---

## What it is

- **A walk, not a playlist.** The engine holds a cursor and a lookahead of two
  tracks. It never materialises a list, so the stream is infinite by
  construction and every step can react to what you just heard (and to what you
  skipped).
- **Rules, in one file.** Which track comes next is decided by *constraints*
  (hard: no repeats, artist spacing) and *scorers* (soft: graph affinity, genre
  inertia, mood and tempo continuity, freshness…), all in
  [`src/core/rules.js`](src/core/rules.js). The real rule set is the next piece
  of work — this is the scaffolding it plugs into. See
  [`docs/RULES.md`](docs/RULES.md).
- **Provider-agnostic playback.** Spotify is an implementation, not an
  assumption. Everything above `src/providers/` deals in archive tracks and one
  playback contract, so a second platform is a new folder and a line in a
  registry. See [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
- **Minimalist.** One screen, one accent colour (the genre of the track), three
  buttons. Everything else lives behind one chip.

```
   core/graph.js      the archive: nodes, links, neighbours
   core/rules.js      constraints + scorers          ← the rules live here
   core/walker.js     the endless walk, one step at a time
        │
   radio/useRadio.js  the engine: walk ⇄ player
        │
   providers/         Spotify Connect · Spotify preview · Dry run
        │
   ui/                cover, two lines, three buttons
```

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/new-release-radio/
```

The archive is fetched from the live Atlas at runtime, with the copy in
`public/graph.json` as the offline fallback — so the radio works with no setup,
and follows the Atlas as new playlists land there.

Watch the rules work without a browser or an account:

```bash
node scripts/walk.mjs -n 40                 # 40 steps of the default station
node scripts/walk.mjs -n 200 --preset drift --explain
node scripts/walk.mjs -n 500 --stats-only   # repeats, artist spread, genre runs
```

Same seed + same preset + same archive = the same walk, every time.

Check what happens when the network comes and goes — the hardest thing to test by
hand, and the source of the worst bug this app has had:

```bash
node scripts/net_tests.mjs           # 17 cases, ~10 minutes
node scripts/net_tests.mjs --only 3  # just the recovery case
node scripts/net_tests.mjs --headed  # watch it happen
```

Spotify is stubbed at the network boundary and keeps real state — a device, a
current track, an actual queue — so every check asserts on what the app *sent to
the device* or what the screen *says*.

And that the layout holds at every window size — the square cover has broken four
times, each time invisibly at whatever size the author happened to have open:

```bash
node scripts/fit_tests.mjs           # 11 windows, ~1 minute
node scripts/fit_tests.mjs --shots /tmp/shots
```

Both need a Chromium that Playwright can drive; see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), "Verification".

### Production build

```bash
npm run build     # dist/
npm run preview   # serve dist/ for a realistic check
```

> The app reads `graph.json` over `fetch`, so it needs a server (dev, preview,
> or Pages). Opening `dist/index.html` from the file system will not work.

---

## Listening

Three players ship, picked from the provider registry:

| player | what you hear | needs |
| --- | --- | --- |
| **Spotify preview** (default) | 30 s previews, advanced automatically | nothing |
| **Spotify Connect** | **whole tracks**, on your own Spotify device | Premium login |
| **Dry run** | nothing — a silent walk at up to 120× | nothing |

**Spotify Connect is the real radio.** Playback is started once on the seed
track and every track the walk decides is appended to Spotify's own queue
(`POST /me/player/queue`), so the stream never stops, never restarts, and no
playlist is ever created. The app is a remote control: the audio comes out of
Spotify on the device you choose.

**A live Spotify session always wins.** If there is a token, the radio
remote-controls Spotify — it never serves 30-second previews to someone with a
Premium session just because previews are what played last time. And if Spotify
is *already playing* when the page loads, the radio **joins that session**
instead of interrupting it: no restart, and when the track is in the archive the
walk continues from it. The only things that outrank this are `?player=<id>` in
the URL and a player you picked by hand in the panel.

It also works the other way round — if you change track yourself in Spotify, the
walk **moves onto that track** and carries on from there instead of fighting you.

**One player, ours.** Whatever the source, the page shows a single set of
controls: cover, progress, play/pause, next, new station, volume, and a pill for
the device. When previews are the source, Spotify's iframe still decodes the
audio but is **caged** and inert — an engine, not a second player.

> The cage matters: the Spotify iFrame API **replaces** the element you hand it
> with its own `<iframe>`, so styling that element does nothing — the player
> lands in the layout, full width, with Spotify's own controls. `.embed-cage`
> wraps it instead, and the API can do what it likes to the child inside.

**On a phone.** Two things work differently, both deliberate:

- **The queue is deeper when the app is not on screen.** A mobile browser freezes
  timers the moment you lock the screen, so a radio holding a single track in
  Spotify's queue runs dry within minutes and Spotify's own autoplay takes the
  session over — you are no longer listening to the walk. Hidden, the radio queues
  enough tracks to cover **ten minutes of music** (counted in minutes, not in
  tracks: a two-minute track buys half of what a five-minute one does); visible,
  **one**, so the rules panel stays responsive. Coming back, the walk
  **fast-forwards** over whatever played while it was asleep instead of losing
  those steps.
- **Connect comes first.** Before the first play on a touch device the cover
  offers `connect Spotify`, with previews underneath, named for what they are:
  30-second clips, no volume, and on iOS a cross-origin iframe that wants the tap
  inside itself.

**Not connected?** A `connect Spotify` pill sits in the top bar — the preview
provider has no login of its own, so the pill asks the registry for the player
that does full tracks. Without it the main screen dead-ended: no volume, no
device list, 30-second clips, and no way out that did not involve finding the
panel.

**Volume** drives the real device volume over Connect. The Spotify preview embed
exposes no volume control at all, so there the slider stays visible but disabled
and says why, rather than pretending to work.

**Where it plays**: the pill in the top bar lists your Spotify devices (phone,
desktop, speaker, car) and moves the stream without a gap — it is the contract's
`CAPS.OUTPUTS`, not a Spotify special case, so a future platform gets the same
pill for free.

**Dry run** is for developing the rules: covers and captions run past at speed
with no streaming account and no network, and it is the proof that the provider
seam is real.

### Spotify setup (Connect only)

Login is OAuth **Authorization Code + PKCE**, entirely client-side — no secret in
the bundle, no backend. The redirect URI is computed as
`window.location.origin + BASE_URL`, so **every deployment's URL must be
registered** in the Spotify app dashboard:

```
https://marcomauro.github.io/new-release-radio/     # production
http://localhost:5173/new-release-radio/            # local dev
```

The client id lives in [`src/providers/spotify/auth.js`](src/providers/spotify/auth.js)
and can be overridden at build time with `VITE_SPOTIFY_CLIENT_ID`.
Without the redirect registered, the previews still work: only Connect needs it.

### Cover art

`graph.json` is metadata only, so covers are resolved per track and cached in
`localStorage`:

- **connected** → `GET /tracks?ids=…`, batched, album art at full size;
- **anonymous** → the public **oEmbed** endpoint (no token, no scope), asking
  optimistically for the 640 px variant of the returned thumbnail;
- **neither** → a placeholder tinted with the track's genre colour, showing the
  artist's initials. The screen is never empty and never shows a broken image.

---

## Keyboard

| key | |
| --- | --- |
| `space` | play / pause |
| `→` | next track (the walk moves on, and remembers the skip) |
| `s` | open / close the panel |

---

## Data

The radio does not own any data. It reads the `graph.json` published by New
Release Atlas — the same compact "format 2" the map uses: nodes are tracks,
links carry their components `c = [artist, primary, secondary, playlist]` so the
walk can tell *why* two tracks are connected, and `meta.linkWeights` gives the
default weight of each kind of link.

```bash
python3 scripts/sync_graph.py                    # sibling checkout, else the live URL
python3 scripts/sync_graph.py --from ../new-release-atlas/public/graph.json
python3 scripts/sync_graph.py --check            # validate the snapshot (CI does this)
```

`sync_graph.py` is standard-library only, validates before writing, keeps a
`.bak`, and updates the `Archive:` line in this README so the numbers never drift
from the data. CI refreshes the snapshot on every deploy and weekly, so the
offline copy does not go stale on its own.

To add tracks, add a playlist **to the Atlas** — the radio picks it up on the
next load.

---

## Install as an app (PWA)

Installable on desktop and mobile, and the walk keeps working offline (playback
obviously still needs the network). A service worker precaches the app shell and
the archive snapshot; cover art is cached separately, cache-first.

---

## Deploy to GitHub Pages

Every push to `main` builds and publishes `dist/` via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which also
refreshes the archive snapshot, validates it, and runs a 120-step walk as a
smoke test.

### Note on `base` (critical)

Pages serves project sites from `/<repo-name>/`. In
[`vite.config.js`](vite.config.js), `base` **must** equal the repository name:

```js
const base = '/new-release-radio/'
```

Rename the repo and this has to follow, or production goes blank: the archive
fallback path, the PWA scope and the Spotify redirect URI all derive from it.

### First-time setup

1. create the empty `new-release-radio` repository on GitHub;
2. push this project to `main`;
3. **Settings → Pages → Source: GitHub Actions**;
4. register the Pages URL as a Spotify redirect URI (see above) if you want
   Connect.

---

## Project structure

```
new-release-radio/
├── .github/workflows/deploy.yml   # build + deploy to Pages
├── docs/
│   ├── ARCHITECTURE.md            # how the pieces fit, and why
│   ├── RULES.md                   # the rule contract — read before editing rules
│   └── PROVIDERS.md               # how to add a streaming platform
├── public/graph.json              # vendored archive snapshot (fallback / offline)
├── scripts/
│   ├── sync_graph.py              # refresh + validate the snapshot
│   ├── walk.mjs                   # run the walk in the terminal
│   ├── net_tests.mjs              # the radio on a network that comes and goes
│   ├── fit_tests.mjs              # the layout at eleven window sizes
│   └── make_icons.mjs             # re-render the PNG icons from one SVG source
├── src/
│   ├── core/
│   │   ├── graph.js               # load + hydrate + index the archive
│   │   ├── rules.js               # CONSTRAINTS + SCORERS + presets
│   │   └── walker.js              # the station: one step at a time
│   ├── providers/
│   │   ├── provider.js            # the playback contract (CAPS, Snapshot, Result)
│   │   ├── index.js               # the registry
│   │   ├── simulated.js           # dry run: the radio with the sound off
│   │   └── spotify/               # auth (PKCE) · api · connect · embed · artwork
│   ├── radio/useRadio.js          # the engine: walk ⇄ player
│   ├── ui/                        # Cover · Controls · OutputPill · Panel
│   ├── App.jsx · theme.js · index.css
└── vite.config.js
```

---

## Where this goes next

- **The real rules.** Everything in `rules.js` today is a working default, not
  the final answer: time of day, energy arcs across an hour, key/harmonic
  transitions, "never two remixes in a row", listening history across sessions.
  The engine, the UI and the players should not need to change for any of them.
- **A second platform.** The contract in `docs/PROVIDERS.md` exists so the
  archive can outlive Spotify. The Dry-run provider is there to keep that path
  honest.
- **Sharing a station.** A walk is reproducible from `(seed, preset, archive)`,
  so a station is a URL: `?seed=<track-id>&preset=drift`.
- **A rolling playlist instead of the queue — decided when the current build has
  been lived with.** Playback is started with `play([one uri])`, so the Spotify
  context is a *single track*. That one fact is the root of the whole family of
  playback bugs this app has had: the return to the first track when the queue
  empties, the stall that followed it, and Spotify's autoplay leaking into the
  queue we read. One private playlist, used as the context and appended to as the
  walk decides, removes all three — it is what New Release Atlas did, and why its
  streaming never stopped. See `docs/ARCHITECTURE.md`, "Two radios, one account"
  and "A buffer instead of a queue", for the sizing, the trade-offs, and the one
  platform behaviour that must be verified before building on it.

---

## Related

- **[New Release Atlas](https://github.com/marcomauro/new-release-atlas)** — the
  map, the archive and the data pipeline this radio walks. Genre colours and link
  weights are deliberately the same, so a track keeps its identity between the
  two projects.
