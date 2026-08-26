import React, { useEffect, useRef, useState } from 'react'
import { gLabel } from '../theme.js'

/* The cover is the interface. Three states, in order of preference:
   the resolved artwork, the lower-resolution variant if the first 404s, and a
   genre-tinted placeholder with the artist's initials so the screen is never
   empty (and never shows a broken image).

   Before the first play the cover carries the way in. On a phone that means
   putting Spotify Connect FIRST: previews are a 30-second consolation prize and
   on a touch device they are also the fragile path (a cross-origin iframe wants
   the tap inside itself). So the primary button connects, and the previews stay
   available underneath, named for what they are.

   Once the radio is playing, a tap turns the cover over: the back carries
   everything the archive knows about the track. That is the whole detail view —
   no second screen, no panel to open, and the one surface big enough to hold it
   on a phone is the one already filling the screen. It flips back on the next
   tap, and by itself when the track changes: a new track has earned its image.

   Nothing on the back is invented. Every line is a field of the archive, and
   the two that are inferred rather than measured say so. */

const initials = (node) =>
  (node ? node.artist || node.title || '' : '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

const pct = (v) => Math.max(0, Math.min(100, Math.round((v || 0) * 100)))

// The archive's audio features, in words a listener recognises. "valence" and
// "instrumentalness" are Spotify's vocabulary, not anybody else's.
const FEATURES = [
  ['energy', 'energy'],
  ['danceability', 'danceable'],
  ['valence', 'bright'],
  ['acousticness', 'acoustic'],
  ['instrumentalness', 'no vocals'],
]

// Where the track sits in the archive's own order, in words. `era_norm` is a
// 0→1 position, and a five-word scale says what a bare number cannot.
const ERA_WORDS = ['oldest', 'early', 'middle', 'recent', 'newest']
const eraWord = (n) => ERA_WORDS[Math.max(0, Math.min(4, Math.floor(n * 5)))]

const Bar = ({ label, value }) => (
  <div className="feat">
    <span className="k">{label}</span>
    <span className="rail">
      <span className="fill" style={{ width: `${pct(value)}%` }} />
    </span>
    <span className="v">{pct(value)}</span>
  </div>
)

const Row = ({ label, children }) =>
  children ? (
    <div className="row">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  ) : null

/** Everything the archive knows about the track, on the back of the sleeve. */
function Back({ node, why }) {
  if (!node) return null
  const others = (node.genres || []).filter((g) => g !== node.genre)
  const mood = Array.isArray(node.mood) ? node.mood : node.mood ? [node.mood] : []
  const subs = (node.subgenres || []).filter((s) => s.toLowerCase() !== gLabel(node.genre).toLowerCase())
  const hasFeatures = FEATURES.some(([key]) => typeof node[key] === 'number')
  // Short phrases on purpose: this line has one square to live in.
  const map = []
  if (node.degree) map.push(`${node.degree} links`)
  if (node.is_bridge) map.push(`bridges ${node.genre_count || 2} genres`)
  if (node.artist_track_count > 1) map.push(`${node.artist_track_count} by this artist`)
  if (node.playlists && node.playlists.length)
    map.push(`${node.playlists.length} playlist${node.playlists.length > 1 ? 's' : ''}`)

  return (
    <div className="sleeve">
      {/* No title here on purpose: it is already on screen, right under the
          cover, and stays there while the sleeve is turned. The back carries
          only what cannot be seen anywhere else.

          The walk's own reason comes first — the one line that is about this
          track *in this station*. (`reason`, not `why`: that class already
          belongs to the genre line under the title, and reusing it inherited
          its centring.) */}
      {why && why.text && (
        <div className="block reason">
          <span className="k">why this track</span>
          <span className="v">{why.text}</span>
        </div>
      )}

      <div className="facts">
        {/* Tempo and length share a row: they are both one short number, and the
            square is the whole detail view. */}
        <Row label="track">
          {node.bpm ? `${node.bpm} bpm` : null}
          {node.bpm && node.duration ? ' · ' : ''}
          {node.duration || null}
          {node.is_remix ? <em> · remix</em> : null}
          {node.bpm && node.bpm_source ? <em> · {node.bpm_source} tempo</em> : null}
        </Row>
        <Row label="genre">
          {gLabel(node.genre)}
          {others.length ? <em> · also {others.map(gLabel).join(', ')}</em> : null}
        </Row>
        <Row label="styles">{subs.length ? subs.join(' · ') : null}</Row>
        <Row label="mood">{mood.length ? mood.join(' · ') : null}</Row>
        {typeof node.era_norm === 'number' ? (
          <Row label="archive">
            {eraWord(node.era_norm)}
            <em> of the run so far</em>
          </Row>
        ) : null}
      </div>

      {hasFeatures && (
        <div className="feats">
          {FEATURES.map(([key, label]) =>
            typeof node[key] === 'number' ? <Bar key={key} label={label} value={node[key]} /> : null
          )}
        </div>
      )}

      {map.length > 0 && (
        <div className="block">
          <span className="k">on the map</span>
          <span className="v">{map.join(' · ')}</span>
        </div>
      )}

      {node.url && (
        <a
          className="out"
          href={node.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          open in Spotify ↗
        </a>
      )}
    </div>
  )
}

// A tap turns the sleeve; a scroll must not. The back is taller than the square
// on a phone, so without this a flick through the facts closes the thing you are
// reading — the browser reports a click at the end of the gesture either way.
const TAP_SLOP = 12

export default function Cover({ cover, node, started, playing, onPlay, connectFirst, onConnect, why }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)
  const [flipped, setFlipped] = useState(false)
  const down = useRef(null)

  useEffect(() => {
    setSrc(cover ? cover.url : null)
    setFailed(false)
  }, [cover, node && node.id])

  // A new track gets its image back: the cover is the interface, and staying on
  // the back for a track the user has not seen is a worse default than turning.
  useEffect(() => {
    setFlipped(false)
  }, [node && node.id])

  const showImage = src && !failed
  // Before the first play the cover carries the way in, so it must not flip:
  // the tap belongs to Connect (or previews), not to a detail view.
  const canFlip = started && !!node

  return (
    <div
      className={`cover${playing ? '' : ' idle'}${flipped ? ' flipped' : ''}`}
      onPointerDown={canFlip ? (e) => { down.current = { x: e.clientX, y: e.clientY } } : undefined}
      onClick={
        canFlip
          ? (e) => {
              const from = down.current
              down.current = null
              // A drag is a scroll through the facts, not a tap on the sleeve.
              if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > TAP_SLOP) return
              setFlipped((f) => !f)
            }
          : undefined
      }
      // Enter only: Space is the radio's play/pause everywhere in the app.
      onKeyDown={
        canFlip
          ? (e) => {
              if (e.key === 'Enter') setFlipped((f) => !f)
            }
          : undefined
      }
      role={canFlip ? 'button' : undefined}
      tabIndex={canFlip ? 0 : undefined}
      aria-label={canFlip ? (flipped ? 'Show the cover' : 'Show the track details') : undefined}
      aria-pressed={canFlip ? flipped : undefined}
    >
      <div className="flip">
        <div className="face front">
          {showImage ? (
            <img
              src={src}
              alt=""
              onError={() => {
                if (cover && cover.fallback && src !== cover.fallback) setSrc(cover.fallback)
                else setFailed(true)
              }}
            />
          ) : (
            <div className="fallback">{initials(node) || '♫'}</div>
          )}
          {!started &&
            (connectFirst ? (
              <div className="veil offer">
                <button className="connect-big" onClick={onConnect}>
                  connect Spotify
                </button>
                <div className="sub">whole tracks, on this phone or any of your devices</div>
                <button className="tiny" onClick={onPlay}>
                  or listen to 30-second previews
                </button>
              </div>
            ) : (
              <div className="veil">
                <button className="bigplay" onClick={onPlay} aria-label="Start the radio">
                  ▶
                </button>
              </div>
            ))}
          {/* Nobody taps a cover to see if it turns over: say that it does. */}
          {canFlip && <span className="turn" aria-hidden="true">i</span>}
        </div>
        <div className="face back">
          <Back node={node} why={why} />
        </div>
      </div>
    </div>
  )
}
