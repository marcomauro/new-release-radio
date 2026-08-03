/* Genre palette — same hues as New Release Atlas, so a track keeps its colour
   between the map and the radio. Here it is used sparingly: one dot, one line,
   and the ambient glow behind the cover. */

export const GENRE_COLOR = {
  'neo-soul': '#c75b4a',
  electronic: '#3a7d8c',
  jazz: '#d39a3e',
  alt: '#8a6d9e',
  'uk-jazz': '#6b8e5a',
  'hip-hop': '#b5697e',
  world: '#bf8b4a',
  'soulful-house': '#4f9e9e',
  'soul-funk': '#9e6b52',
  'broken-beat': '#7d8c4f',
  downtempo: '#5b6b9e',
  classical: '#7a8aa0',
  unknown: '#b8b0a4',
}

export const GENRE_LABEL = {
  'neo-soul': 'Neo-Soul / R&B',
  electronic: 'Electronic',
  jazz: 'Jazz',
  alt: 'Alt / Indie',
  'uk-jazz': 'UK Jazz',
  'hip-hop': 'Hip-Hop',
  world: 'World / Afro / Latin',
  'soulful-house': 'Soulful House',
  'soul-funk': 'Soul / Funk',
  'broken-beat': 'Broken Beat',
  downtempo: 'Downtempo',
  classical: 'Classical / Score',
  unknown: 'Unclassified',
}

// Deterministic fallback hue for a genre adopted after this file was written.
const auto = new Map()
export function gColor(g) {
  if (!g) return GENRE_COLOR.unknown
  if (GENRE_COLOR[g]) return GENRE_COLOR[g]
  let c = auto.get(g)
  if (!c) {
    let h = 0
    for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) | 0
    c = `hsl(${(h >>> 0) % 360}, 38%, 52%)`
    auto.set(g, c)
  }
  return c
}

export const gLabel = (g) => GENRE_LABEL[g] || g || 'Unclassified'

export const fmtTime = (ms) => {
  if (!ms || ms < 0) return '0:00'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
