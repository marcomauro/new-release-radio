import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves project sites from /<repo-name>/. `base` MUST match the
// repository name exactly, or the assets 404 in production and the page stays
// black. Everything derives from it: the local graph.json fallback, the PWA
// scope, and the Spotify OAuth redirect URI.
const base = '/new-release-radio/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180.png'],
      manifest: {
        id: base,
        name: 'New Release Radio',
        short_name: 'Radio',
        description: 'Endless radio over the New Release Atlas archive.',
        lang: 'en',
        dir: 'ltr',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0d0d0f',
        background_color: '#0d0d0f',
        categories: ['music', 'entertainment'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell + the vendored graph snapshot: the walk keeps working
        // offline (playback obviously still needs the network).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json,webmanifest,woff2}'],
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // Cover art (Spotify oEmbed thumbnails / CDN images): cache-first,
            // they never change for a given track.
            urlPattern: ({ url }) => /(^|\.)scdn\.co$/.test(url.hostname) || url.hostname === 'open.spotify.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'cover-art',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
