#!/usr/bin/env node
/* ----------------------------------------------------------------------------
   make_icons.mjs — regenerate the PNG icons from one SVG source.

   The motif is the New Release Atlas graph — same nodes, same genre palette —
   on the Atlas paper colour (#f4f1ea) rather than its ink: one family, two
   apps. Keeping the source here means the icons can be re-rendered instead of
   being binaries nobody can edit.

     node scripts/make_icons.mjs

   Needs a Chromium that Playwright can drive (PLAYWRIGHT_BROWSERS_PATH or a
   local install); it is a build-time tool, never shipped to the browser.
   Outputs: pwa-192-v2.png, pwa-512-v2.png, pwa-maskable-512-v2.png,
   apple-touch-icon-180-v2.png in public/.

   The `-vN` suffix is deliberate: an installed PWA keeps the icon it fetched
   at install time, and an unchanged URL gives the platform no reason to look
   again. When the artwork changes, bump the suffix here and in vite.config.js.
   -------------------------------------------------------------------------- */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '..', 'public')

const PAPER = '#f4f1ea'
const INK = '#2b2724'

// The graph, in a 64×64 box. `scale` shrinks the drawing inside the tile, which
// is what a maskable icon needs (the platform crops to a circle).
const motif = (scale = 1) => {
  const t = ((1 - scale) * 64) / 2
  return `
  <g transform="translate(${t} ${t}) scale(${scale})">
    <g stroke="${INK}" stroke-opacity="0.3" stroke-width="1.3" stroke-linecap="round">
      <line x1="32" y1="32" x2="21.9" y2="23.6"/>
      <line x1="32" y1="32" x2="42.1" y2="22.3"/>
      <line x1="32" y1="32" x2="17.9" y2="36.4"/>
      <line x1="32" y1="32" x2="45.2" y2="38.2"/>
      <line x1="32" y1="32" x2="27.2" y2="43.4"/>
      <line x1="32" y1="32" x2="37.7" y2="44.8"/>
      <line x1="32" y1="32" x2="32" y2="21.4"/>
      <line x1="21.9" y1="23.6" x2="17.9" y2="36.4"/>
      <line x1="42.1" y1="22.3" x2="45.2" y2="38.2"/>
    </g>
    <g stroke="${PAPER}" stroke-width="1.2">
      <circle cx="32" cy="32" r="5.6" fill="#c75b4a"/>
      <circle cx="21.9" cy="23.6" r="3.2" fill="#3a7d8c"/>
      <circle cx="42.1" cy="22.3" r="3.4" fill="#d39a3e"/>
      <circle cx="17.9" cy="36.4" r="2.9" fill="#8a6d9e"/>
      <circle cx="45.2" cy="38.2" r="3.2" fill="#6b8e5a"/>
      <circle cx="27.2" cy="43.4" r="3.0" fill="#b5697e"/>
      <circle cx="37.7" cy="44.8" r="2.8" fill="#bf8b4a"/>
      <circle cx="32" cy="21.4" r="2.4" fill="#b8b0a4"/>
    </g>
  </g>`
}

const svg = ({ scale = 1, radius = 0 }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${radius}" fill="${PAPER}"/>
  ${motif(scale)}
</svg>`

const ICONS = [
  // Full-bleed light tile: the OS rounds it as it likes.
  { file: 'pwa-192-v2.png', size: 192, scale: 1.15, radius: 0 },
  { file: 'pwa-512-v2.png', size: 512, scale: 1.15, radius: 0 },
  // Maskable: everything important inside the safe circle (~80%).
  { file: 'pwa-maskable-512-v2.png', size: 512, scale: 0.72, radius: 0 },
  // iOS rounds the corners itself, so ship it square.
  { file: 'apple-touch-icon-180-v2.png', size: 180, scale: 1.15, radius: 0 },
]

const { chromium } = await import('playwright').catch(() =>
  import('/opt/node22/lib/node_modules/playwright/index.mjs')
)

const browser = await chromium.launch({
  args: ['--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
mkdirSync(out, { recursive: true })

for (const icon of ICONS) {
  const page = await browser.newPage({
    viewport: { width: icon.size, height: icon.size },
    deviceScaleFactor: 1,
  })
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;padding:0}svg{display:block;width:${icon.size}px;height:${icon.size}px}</style>${svg(icon)}`
  )
  const png = await page.screenshot({ omitBackground: false })
  writeFileSync(resolve(out, icon.file), png)
  await page.close()
  console.log(`${icon.file}  ${icon.size}×${icon.size}  ${(png.length / 1024).toFixed(1)} kB`)
}

await browser.close()
