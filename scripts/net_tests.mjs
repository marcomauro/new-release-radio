#!/usr/bin/env node
/* ----------------------------------------------------------------------------
   net_tests.mjs — what the radio does when the network comes and goes.

   The bug this suite exists for could not be reproduced by reading: a dropped
   request used to be reported as "nothing is playing", which put a ▶ on screen
   while Spotify was playing and made the next tap restart the track. None of
   that is visible without a network that fails on demand — and a real flaky
   connection is not a test.

   So Spotify is stubbed at the network boundary (Playwright routing, so the
   page's own fetch is what fails) and the stub keeps real state: a device, a
   current track, an actual queue. Every assertion is about what the app SENT to
   the device or what the screen SAYS — never about pixels, and never about a
   promise we made in a comment.

     node scripts/net_tests.mjs                # all cases
     node scripts/net_tests.mjs --only 3,4     # a subset
     node scripts/net_tests.mjs --headed       # watch it happen

   Needs a Chromium that Playwright can drive; it is a development tool and does
   not run in the deploy workflow (see docs/ARCHITECTURE.md, "Verification").
   -------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const BASE = '/new-release-radio/'
const PORT = 5178
const ORIGIN = `http://localhost:${PORT}`

const args = process.argv.slice(2)
const only = (() => {
  const i = args.indexOf('--only')
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map((s) => s.trim()) : null
})()
const headed = args.includes('--headed')

const graph = JSON.parse(readFileSync(resolve(root, 'public', 'graph.json'), 'utf8'))
const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* --- the world the stub keeps -------------------------------------------- */

const DEVICE = {
  id: 'dev-phone-1',
  is_active: true,
  is_private_session: false,
  is_restricted: false,
  name: 'S25 FE di Marco',
  type: 'Smartphone',
  volume_percent: 62,
  supports_volume: true,
}

function makeWorld(startId) {
  return {
    // 'ok' | 'fail' (nothing arrives) | 'fail-reads' (only reads fail) | 'hang'
    mode: 'ok',
    playing: true,
    current: startId,
    position: 12000,
    queue: [], // track ids Spotify holds, in order
    volume: DEVICE.volume_percent,
    tokenMode: 'ok', // 'ok' | 'fail' | 'invalid_grant'
    seen: [], // every request the stub was asked for, fulfilled or not
    calls: [], // every request it actually answered: `${method} ${path}`
  }
}

const item = (id) => {
  const n = nodeById.get(id)
  return {
    id,
    name: (n && n.title) || id,
    duration_ms: Math.round(((n && n.duration_sec) || 210) * 1000),
    uri: `spotify:track:${id}`,
    artists: [{ name: (n && n.artist) || 'unknown' }],
    album: { images: [{ url: `${ORIGIN}${BASE}favicon.svg`, width: 640, height: 640 }] },
  }
}

const idFromUri = (uri) => (uri || '').replace('spotify:track:', '')

/** Answer one Spotify Web API request against the world. */
function answer(world, method, path, search, body) {
  const p = path.replace('/v1', '')
  if (method === 'GET' && p === '/me/player') {
    if (!world.current) return { status: 204 }
    return {
      json: {
        device: { ...DEVICE, volume_percent: world.volume },
        is_playing: world.playing,
        progress_ms: world.position,
        item: item(world.current),
      },
    }
  }
  if (method === 'GET' && p === '/me/player/devices') {
    return { json: { devices: [{ ...DEVICE, volume_percent: world.volume }] } }
  }
  if (method === 'GET' && p === '/me/player/queue') {
    return {
      json: {
        currently_playing: world.current ? item(world.current) : null,
        queue: world.queue.map(item),
      },
    }
  }
  if (method === 'PUT' && p === '/me/player/play') {
    const uris = body && body.uris
    if (uris && uris.length) {
      // A real `play` replaces the context: this is the restart we must never
      // see happen from a stale state.
      world.current = idFromUri(uris[0])
      world.position = 0
      world.queue = []
    }
    world.playing = true
    return { status: 204 }
  }
  if (method === 'PUT' && p === '/me/player/pause') {
    world.playing = false
    return { status: 204 }
  }
  if (method === 'POST' && p === '/me/player/queue') {
    const uri = search.get('uri')
    if (uri) world.queue.push(idFromUri(uri))
    return { status: 204 }
  }
  if (method === 'POST' && p === '/me/player/next') {
    const nextId = world.queue.shift()
    if (nextId) {
      world.current = nextId
      world.position = 0
      world.playing = true
    }
    return { status: 204 }
  }
  if (method === 'PUT' && p === '/me/player/volume') {
    world.volume = Number(search.get('volume_percent'))
    return { status: 204 }
  }
  if (method === 'PUT' && p === '/me/player') return { status: 204 } // transfer
  if (method === 'PUT' && p === '/me/player/seek') {
    world.position = Number(search.get('position_ms')) || 0
    return { status: 204 }
  }
  if (method === 'GET' && p.startsWith('/tracks')) {
    const ids = (search.get('ids') || '').split(',').filter(Boolean)
    return { json: { tracks: ids.map(item) } }
  }
  return { status: 404, json: { error: { status: 404, message: 'stub has no route' } } }
}

/* --- wiring the stub into the page --------------------------------------- */

async function install(page, world) {
  // The archive: served locally so the test never depends on the live Atlas.
  await page.route('**://marcomauro.github.io/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) })
  )
  // Covers and the preview iframe are not what is under test.
  await page.route('**://open.spotify.com/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ thumbnail_url: '' }) })
  )

  await page.route('**://accounts.spotify.com/api/token', async (route) => {
    world.seen.push('POST /api/token')
    if (world.tokenMode === 'fail') return route.abort('connectionfailed')
    if (world.tokenMode === 'invalid_grant') {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant' }),
      })
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: `tok-${Date.now()}`,
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: '',
      }),
    })
  })

  await page.route('**://api.spotify.com/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const method = req.method()
    const isRead = method === 'GET'
    world.seen.push(`${method} ${url.pathname}`)

    if (world.mode === 'hang') {
      // A stalled mobile connection does not fail, it stops answering. The
      // request stays open long past the app's own deadline, which is what must
      // abort it — the late abort here only tidies up.
      await sleep(30000)
      try {
        await route.abort('timedout')
      } catch (e) {
        /* the page moved on, as it should have */
      }
      return
    }
    if (world.mode === 'fail' || (world.mode === 'fail-reads' && isRead)) {
      return route.abort('connectionfailed')
    }

    let body = null
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null
    } catch (e) {
      /* not JSON */
    }
    const out = answer(world, method, url.pathname, url.searchParams, body)
    // A restart and a resume are the same endpoint; only the body tells them
    // apart, and only one of them is the bug.
    let label = `${method} ${url.pathname.replace('/v1', '')}`
    if (label === 'PUT /me/player/play' && body && body.uris) label += ' [restart]'
    world.calls.push(label)
    if (out.status === 204) return route.fulfill({ status: 204, body: '' })
    return route.fulfill({
      status: out.status || 200,
      contentType: 'application/json',
      body: JSON.stringify(out.json || null),
    })
  })
}

/** A logged-in browser: tokens in place before any script runs. */
const seedTokens = (expired = false) => `
  localStorage.setItem('nrr_sp_tokens', JSON.stringify({
    access_token: 'tok-seed',
    refresh_token: 'refresh-1',
    expires_at: ${expired ? 'Date.now() - 1000' : 'Date.now() + 3600000'},
    scope: ''
  }))
  localStorage.removeItem('nrr_session_v1')
`

/* --- reading the screen -------------------------------------------------- */

const ui = {
  title: (p) => p.locator('.meta .title').innerText(),
  why: (p) => p.locator('.meta .why').innerText(),
  step: async (p) => {
    const t = await p.locator('.footer .label').last().innerText()
    return Number(t.replace('#', '').trim())
  },
  clock: (p) => p.locator('.bar span').first().innerText(),
  notice: async (p) => ((await p.locator('.notice').count()) ? p.locator('.notice').innerText() : ''),
  paused: async (p) => (await p.locator('.ctl.main[title="Play"]').count()) > 0,
  linkDot: async (p) => (await p.locator('.chip.out .link-dot').count()) > 0,
  hasOutputPill: async (p) => (await p.locator('.chip.out').count()) > 0,
  hasConnectPill: async (p) => (await p.locator('.chip.connect').count()) > 0,
}

const clockToMs = (s) => {
  const [m, sec] = s.split(':').map(Number)
  return (m * 60 + sec) * 1000
}

/* --- the harness --------------------------------------------------------- */

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  const mark = pass ? '[32mPASS[0m' : '[31mFAIL[0m'
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function openRadio(browser, world, { expiredToken = false, startId } = {}) {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 } })
  const page = await context.newPage()
  await page.addInitScript(seedTokens(expiredToken))
  await install(page, world)
  await page.goto(`${ORIGIN}${BASE}?track=${startId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.meta .title', { timeout: 15000 })
  return { context, page }
}

/** Wait until the app has adopted the stub's session and is polling. */
async function settle(page, world) {
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.bar span')
      return t && t.textContent !== '0:00'
    },
    { timeout: 15000 }
  )
  // give the first top-up a chance to reach the stub
  await sleep(1200)
  return world
}

export default async function run() {
  const { chromium } = await import('playwright').catch(() =>
    import('/opt/node22/lib/node_modules/playwright/index.mjs')
  )

  // Detached so the whole process group can be killed: vite survives a SIGTERM
  // sent to the npx wrapper alone, and its open pipes keep node alive for ever.
  const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const stopDev = () => {
    try {
      process.kill(-dev.pid, 'SIGKILL')
    } catch (e) {
      try {
        dev.kill('SIGKILL')
      } catch (e2) {
        /* already gone */
      }
    }
  }
  await new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error('vite did not start')), 30000)
    dev.stdout.on('data', (d) => {
      if (String(d).includes('ready in') || String(d).includes('Local:')) {
        clearTimeout(timer)
        ok()
      }
    })
    dev.on('exit', (c) => bad(new Error(`vite exited (${c})`)))
  })
  await sleep(600)

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  })

  const startId = graph.nodes[0].id
  const want = (n) => !only || only.includes(String(n))

  try {
    /* 1 — a dropped poll must not stop the music, on screen or on the device */
    if (want(1)) {
      console.log('\n1 · polls fail while a track plays')
      const world = makeWorld(startId)
      const { context, page } = await openRadio(browser, world, { startId })
      await settle(page, world)
      const title0 = await ui.title(page)
      const clock0 = clockToMs(await ui.clock(page))
      const playsBefore = world.calls.filter((c) => c.includes('player/play')).length

      world.mode = 'fail'
      await sleep(9000)

      check('the title does not change', (await ui.title(page)) === title0)
      check('the transport still shows Pause', !(await ui.paused(page)))
      check('the clock keeps moving', clockToMs(await ui.clock(page)) > clock0,
        `${clock0}ms → ${clockToMs(await ui.clock(page))}ms`)
      const notice = await ui.notice(page)
      check('no "Failed to fetch" on screen', !/failed to fetch/i.test(notice), notice)
      check('the link shows on the device pill', await ui.linkDot(page))
      check('nothing was sent to the device',
        world.calls.filter((c) => c.includes('player/play')).length === playsBefore)
      await context.close()
    }

    /* 2 — pressing play during an outage must not restart the track */
    if (want(2)) {
      console.log('\n2 · the user presses play while reads are failing')
      const world = makeWorld(startId)
      const { context, page } = await openRadio(browser, world, { startId })
      await settle(page, world)
      const onAir = world.current
      // Reads fail, writes still work: if the app sends a `play` from a stale
      // state, the stub records it and the track restarts. That is the bug.
      world.mode = 'fail-reads'
      await sleep(7000)
      await page.locator('.ctl.main').click()
      await sleep(3000)

      check('no play command was sent', !world.calls.some((c) => c.includes('player/play')),
        world.calls.filter((c) => c.includes('player/play')).join(', '))
      check('the track on the device is unchanged', world.current === onAir)
      check('the device was not rewound', world.position > 0)
      await context.close()
    }

    /* 3 — recovery: fast-forward over what played, never a jump */
    if (want(3)) {
      console.log('\n3 · the network comes back after Spotify has moved on')
      const world = makeWorld(startId)
      const { context, page } = await openRadio(browser, world, { startId })
      await settle(page, world)
      // make sure the queue holds something of ours to move onto
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await sleep(2500)
      const step0 = await ui.step(page)
      const queued = [...world.queue]

      world.mode = 'fail'
      await sleep(8000)
      // Spotify played on while we were blind.
      if (queued.length) {
        world.current = world.queue.shift()
        world.position = 5000
      }
      world.mode = 'ok'
      await sleep(6000)

      const step1 = await ui.step(page)
      check('the walk moved on with the device', queued.length ? step1 > step0 : true,
        `#${step0} → #${step1}`)
      check('no restart was sent', !world.calls.some((c) => c.includes('[restart]')))
      const why = await ui.why(page)
      check('the why-line does not say the walk was re-anchored', !/restart/i.test(why), why)
      const notice = await ui.notice(page)
      check('the network notice cleared itself', !/network|failed to fetch/i.test(notice), notice)
      check('the link dot is gone', !(await ui.linkDot(page)))
      await context.close()
    }

    /* 4 — a request that never answers must not wedge the loop */
    if (want(4)) {
      console.log('\n4 · the connection stalls instead of failing')
      const world = makeWorld(startId)
      const { context, page } = await openRadio(browser, world, { startId })
      await settle(page, world)
      world.mode = 'hang'
      const seen0 = world.seen.filter((s) => s === 'GET /v1/me/player').length
      await sleep(20000)
      const seen1 = world.seen.filter((s) => s === 'GET /v1/me/player').length
      check('the loop kept asking after the first stall', seen1 - seen0 >= 2,
        `${seen1 - seen0} attempts in 20s`)
      world.mode = 'ok'
      // A poll that was already hanging when the network came back still has to
      // burn its own deadline before the next one can answer: allow for it.
      await sleep(20000)
      check('it recovered once answers returned', !(await ui.linkDot(page)))
      await context.close()
    }

    /* 5 — a blip at refresh time is not an expired session */
    if (want(5)) {
      console.log('\n5 · the token refresh cannot reach Spotify')
      const world = makeWorld(startId)
      world.tokenMode = 'fail'
      const { context, page } = await openRadio(browser, world, { startId, expiredToken: true })
      await sleep(9000)
      check('the device pill is still there', await ui.hasOutputPill(page))
      check('no Connect pill appeared', !(await ui.hasConnectPill(page)))
      const notice = await ui.notice(page)
      check('nobody was told the session expired', !/expired|reconnect/i.test(notice), notice)
      await context.close()
    }

    /* 6 — a dead grant still ends the session */
    if (want(6)) {
      console.log('\n6 · the refresh token is genuinely dead')
      const world = makeWorld(startId)
      world.tokenMode = 'invalid_grant'
      const { context, page } = await openRadio(browser, world, { startId, expiredToken: true })
      await sleep(9000)
      const notice = await ui.notice(page)
      const connect = await ui.hasConnectPill(page)
      check('the way back in is offered', connect || /reconnect|expired/i.test(notice),
        `pill=${connect} notice=${notice}`)
      await context.close()
    }

    /* 7 — hidden: the queue must be deep enough to survive the gap */
    if (want(7)) {
      console.log('\n7 · the phone goes in a pocket, then the network drops')
      const world = makeWorld(startId)
      const { context, page } = await openRadio(browser, world, { startId })
      await settle(page, world)
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await sleep(4000)
      const depth = world.queue.length
      check('the queue was deepened for the gap', depth >= 2, `${depth} tracks queued`)

      // three tracks play while we are asleep and blind
      world.mode = 'fail'
      const played = world.queue.splice(0, Math.min(3, world.queue.length))
      if (played.length) {
        world.current = played[played.length - 1]
        world.position = 8000
      }
      const step0 = await ui.step(page)
      world.mode = 'ok'
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await sleep(5000)
      const step1 = await ui.step(page)
      check('the walk fast-forwarded over what played', played.length ? step1 >= step0 + played.length : true,
        `#${step0} → #${step1} for ${played.length} tracks`)
      check('nothing was restarted', !world.calls.some((c) => c.includes('[restart]')))
      await context.close()
    }

    /* 8 — a real offline transition, end to end */
    if (want(8)) {
      console.log('\n8 · the browser itself goes offline and back')
      const world = makeWorld(startId)
      const { context, page } = await openRadio(browser, world, { startId })
      await settle(page, world)
      const title0 = await ui.title(page)
      await context.setOffline(true)
      await sleep(9000)
      check('the screen still names what is playing', (await ui.title(page)) === title0)
      const notice = await ui.notice(page)
      check('no browser wording reached the user', !/failed to fetch/i.test(notice), notice)
      await context.setOffline(false)
      await sleep(8000)
      check('the radio picked itself back up', !(await ui.linkDot(page)))
      check('and it did not restart anything', !world.calls.some((c) => c.includes('[restart]')))
      await context.close()
    }
  } finally {
    await browser.close()
    stopDev()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`
  )
  if (failed.length) for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
  // A pending 'hang' route can still be holding a timer: leave on purpose.
  process.exit(failed.length ? 1 : 0)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
