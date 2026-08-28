#!/usr/bin/env node
/* ----------------------------------------------------------------------------
   fit_tests.mjs — does the layout hold at every window size?

   The square cover is the hardest-won thing in this interface and it has broken
   four times, each time differently: squashed by a flex column, clamped on one
   axis while the other stood, collapsed to a sliver in landscape, and finally
   overflowing UPWARD onto the top bar on a window that was wide enough but not
   tall enough. Every one of those was invisible at the size the author happened
   to have open.

   So the invariants are asserted, not looked at, across a spread of windows:

     • the cover is square and usably big;
     • it never intersects the top bar, the title, the controls or the footer;
     • it stays inside the viewport and nothing scrolls sideways;
     • a click turns the sleeve, and the mark that says so is visible without a
       hover (on a desktop the flip was invisible until the mouse swept over it);
     • the panel's search field lines up with the headings above it, inside the
       column — its own `padding` shorthand used to wipe the gutter and run the
       field to the window edge;
     • the panel stamps the commit and build time, so "am I looking at the
       latest build?" is answered by looking.

     node scripts/fit_tests.mjs                 # every size
     node scripts/fit_tests.mjs --shots <dir>   # also save screenshots

   Needs a Chromium that Playwright can drive; a development tool, not part of
   the deploy workflow. See docs/ARCHITECTURE.md, "Verification".
   -------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '/new-release-radio/'
const PORT = 5180
const ORIGIN = `http://localhost:${PORT}`
const args = process.argv.slice(2)
const shotsAt = args.indexOf('--shots')
const OUT = shotsAt >= 0 ? args[shotsAt + 1] : null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const graph = JSON.parse(readFileSync(`${root}/public/graph.json`, 'utf8'))
const byId = new Map(graph.nodes.map((n) => [n.id, n]))
const START = graph.nodes.find((n) => n.bpm && n.mood && n.subgenres && n.subgenres.length).id

const DEVICE = { id: 'd1', is_active: true, name: "marco's iMac", type: 'Computer', volume_percent: 62, supports_volume: true }
const item = (id) => {
  const n = byId.get(id)
  return { id, name: n.title, duration_ms: (n.duration_sec || 210) * 1000, uri: `spotify:track:${id}`,
    artists: [{ name: n.artist }], album: { images: [{ url: `${ORIGIN}${BASE}pwa-512-v2.png` }] } }
}

const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
await new Promise((ok, bad) => {
  const timer = setTimeout(() => bad(new Error('vite did not start')), 30000)
  dev.stdout.on('data', (d) => {
    if (String(d).includes('ready in') || String(d).includes('Local:')) {
      clearTimeout(timer)
      ok()
    }
  })
  dev.on('exit', (c) => bad(new Error(`vite exited (${c}) — is port ${PORT} already in use?`)))
})
await sleep(500)

const { chromium } = await import('playwright').catch(() =>
  import('/opt/node22/lib/node_modules/playwright/index.mjs')
)
const browser = await chromium.launch({ args: ['--no-sandbox'] })

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  if (!pass) console.log(`    [31mFAIL[0m ${name}${detail ? ` — ${detail}` : ''}`)
}

const queue = []
async function open(size) {
  const touch = size.w < 900
  const context = await browser.newContext({
    viewport: { width: size.w, height: size.h }, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch,
  })
  const page = await context.newPage()
  await page.addInitScript(`
    localStorage.setItem('nrr_sp_tokens', JSON.stringify({
      access_token:'t', refresh_token:'r', expires_at: Date.now()+3600000, scope:''}))
    localStorage.removeItem('nrr_session_v1')`)
  await page.route('**://marcomauro.github.io/**', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }))
  await page.route('**://open.spotify.com/**', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ thumbnail_url: '' }) }))
  await page.route('**://api.spotify.com/**', (route) => {
    const u = new URL(route.request().url())
    const m = route.request().method()
    const p = u.pathname.replace('/v1', '')
    if (m === 'GET' && p === '/me/player')
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        device: DEVICE, is_playing: true, progress_ms: 42000, item: item(START) }) })
    if (m === 'GET' && p === '/me/player/devices')
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ devices: [DEVICE] }) })
    if (m === 'GET' && p === '/me/player/queue')
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        currently_playing: item(START), queue: queue.map(item) }) })
    if (m === 'POST' && p === '/me/player/queue') {
      queue.push((u.searchParams.get('uri') || '').replace('spotify:track:', ''))
      return route.fulfill({ status: 204, body: '' })
    }
    if (m === 'GET' && p.startsWith('/tracks'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        tracks: (u.searchParams.get('ids') || '').split(',').filter(Boolean).map(item) }) })
    return route.fulfill({ status: 204, body: '' })
  })
  await page.goto(`${ORIGIN}${BASE}?track=${START}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.meta .title', { timeout: 15000 })
  await sleep(1800)
  return { context, page }
}

const geom = (page) =>
  page.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel)
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
        right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }
    }
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      topbar: r('.topbar'), cover: r('.cover'), slot: r('.cover-slot'),
      meta: r('.meta'), controls: r('.controls'), footer: r('.footer'),
      turnOpacity: document.querySelector('.cover .turn')
        ? getComputedStyle(document.querySelector('.cover .turn')).opacity : null,
    }
  })

const hits = (a, b) => !!a && !!b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom

// A spread of windows: phones, the tall narrow desktop window from the report,
// and a sweep of heights at a fixed width — the axis that used to break.
const SIZES = [
  { w: 360, h: 740, name: 'phone 360×740' },
  { w: 390, h: 844, name: 'phone 390×844' },
  { w: 360, h: 640, name: 'short phone 360×640' },
  { w: 740, h: 360, name: 'phone landscape' },
  { w: 570, h: 730, name: 'desktop window (reported)' },
  { w: 570, h: 620, name: 'desktop window, shorter' },
  { w: 700, h: 560, name: 'desktop 700×560' },
  { w: 900, h: 500, name: 'desktop 900×500' },
  { w: 1280, h: 800, name: 'desktop 1280×800' },
  { w: 1280, h: 480, name: 'desktop 1280×480 (very short)' },
  { w: 1600, h: 1000, name: 'desktop 1600×1000' },
]

for (const size of SIZES) {
  const { context, page } = await open(size)
  const g = await geom(page)
  const c = g.cover
  console.log(
    `\n${size.name} — cover ${c.w}×${c.h} @ ${c.x},${c.y}  slot ${g.slot.h}h  topbar bottom ${g.topbar.bottom}`
  )

  check(`${size.name}: cover is square`, Math.abs(c.w - c.h) <= 1, `${c.w}×${c.h}`)
  check(`${size.name}: cover has a usable size`, c.w >= 80, `${c.w}px`)
  check(`${size.name}: cover clear of the top bar`, !hits(c, g.topbar),
    `cover top ${c.y} vs topbar bottom ${g.topbar.bottom}`)
  check(`${size.name}: cover clear of the title`, !hits(c, g.meta))
  check(`${size.name}: cover clear of the controls`, !hits(c, g.controls))
  check(`${size.name}: cover clear of the footer`, !hits(c, g.footer))
  check(`${size.name}: cover inside the viewport`, c.y >= -0.5 && c.bottom <= g.vh + 0.5,
    `y ${c.y} bottom ${c.bottom} vh ${g.vh}`)
  check(`${size.name}: nothing scrolls sideways`,
    await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 0.5))

  // the flip: a plain click, and the mark that announces it
  await page.locator('.cover').click({ position: { x: Math.round(c.w / 2), y: Math.round(c.h / 2) } })
  await sleep(800)
  check(`${size.name}: click turns the sleeve`,
    await page.evaluate(() => document.querySelector('.cover').classList.contains('flipped')))
  check(`${size.name}: the turn mark is visible without hover`, Number(g.turnOpacity) > 0.2, `opacity ${g.turnOpacity}`)
  await page.locator('.cover').click({ position: { x: Math.round(c.w / 2), y: Math.round(c.h / 2) } })
  await sleep(600)

  // the panel's search field
  await page.locator('.topbar .chip.accent').click()
  await page.waitForSelector('.panel', { timeout: 5000 })
  await page.locator('.panel > .row .chip', { hasText: 'start' }).first().click()
  await page.waitForSelector('.panel .search', { timeout: 5000 })
  const box = await page.evaluate(() => {
    const p = document.querySelector('.panel')
    const i = document.querySelector('.panel .search')
    const h = document.querySelector('.panel h2')
    const pc = getComputedStyle(p)
    const pr = p.getBoundingClientRect()
    const ir = i.getBoundingClientRect()
    const hr = h.getBoundingClientRect()
    return {
      vw: window.innerWidth,
      padLeft: parseFloat(pc.paddingLeft), padRight: parseFloat(pc.paddingRight),
      panel: { x: pr.x, right: pr.right },
      input: { x: +ir.x.toFixed(1), right: +ir.right.toFixed(1) },
      heading: { x: +hr.x.toFixed(1), right: +hr.right.toFixed(1) },
    }
  })
  const gutterL = box.input.x - box.panel.x
  const gutterR = box.panel.right - box.input.right
  console.log(`  panel search: gutters ${gutterL.toFixed(1)} / ${gutterR.toFixed(1)}  (heading x ${box.heading.x})`)
  check(`${size.name}: search field has a left gutter`, gutterL >= box.padLeft - 0.5, `${gutterL.toFixed(1)}px`)
  check(`${size.name}: search field has a right gutter`, gutterR >= box.padRight - 0.5, `${gutterR.toFixed(1)}px`)
  check(`${size.name}: search field lines up with the headings`,
    Math.abs(box.input.x - box.heading.x) <= 1, `input ${box.input.x} vs heading ${box.heading.x}`)
  check(`${size.name}: search field inside the window`, box.input.right <= box.vw + 0.5)

  // The build stamp: which version am I actually looking at? An installed app
  // serves the version it has until the service worker takes over, and twice a
  // deployed fix was reported as missing when it was only the cached build.
  const stamp = (await page.locator('.info.build').count())
    ? (await page.locator('.info.build').innerText()).replace(/\n/g, ' ')
    : ''
  check(`${size.name}: the panel stamps the build`,
    /^build\s+[0-9a-f]{7}\s+·\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(stamp.trim()), stamp)
  if (OUT && size.name.startsWith('desktop window (rep')) {
    await page.screenshot({ path: `${OUT}/fit-panel.png` })
  }
  await page.locator('.panel .head .chip').last().click()
  await sleep(300)
  if (OUT) await page.screenshot({ path: `${OUT}/fit-${size.w}x${size.h}.png` })
  await context.close()
}

await browser.close()
try { process.kill(-dev.pid, 'SIGKILL') } catch (e) {}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`)
process.exit(failed.length ? 1 : 0)
