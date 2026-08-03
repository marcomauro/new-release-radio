import React, { useEffect, useState } from 'react'

/* The cover is the interface. Three states, in order of preference:
   the resolved artwork, the lower-resolution variant if the first 404s, and a
   genre-tinted placeholder with the artist's initials so the screen is never
   empty (and never shows a broken image). */

const initials = (node) =>
  (node ? node.artist || node.title || '' : '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

export default function Cover({ cover, node, started, playing, onPlay }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setSrc(cover ? cover.url : null)
    setFailed(false)
  }, [cover, node && node.id])

  const showImage = src && !failed

  return (
    <div className={`cover${playing ? '' : ' idle'}`}>
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
      {!started && (
        <div className="veil">
          <button className="bigplay" onClick={onPlay} aria-label="Start the radio">
            ▶
          </button>
        </div>
      )}
    </div>
  )
}
