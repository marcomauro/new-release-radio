import React, { useEffect, useState } from 'react'

/* The cover is the interface. Three states, in order of preference:
   the resolved artwork, the lower-resolution variant if the first 404s, and a
   genre-tinted placeholder with the artist's initials so the screen is never
   empty (and never shows a broken image).

   Before the first play the cover carries the way in. On a phone that means
   putting Spotify Connect FIRST: previews are a 30-second consolation prize and
   on a touch device they are also the fragile path (a cross-origin iframe wants
   the tap inside itself). So the primary button connects, and the previews stay
   available underneath, named for what they are. */

const initials = (node) =>
  (node ? node.artist || node.title || '' : '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

export default function Cover({ cover, node, started, playing, onPlay, connectFirst, onConnect }) {
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
    </div>
  )
}
