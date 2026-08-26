import React, { useEffect, useRef, useState } from 'react'

/* Where the sound comes out. On Spotify Connect these are the user's devices;
   the same pill will serve any future platform that reports CAPS.OUTPUTS,
   because it only speaks the contract (`outputs`, `currentOutput`,
   `selectOutput`), never Spotify. */

const Cast = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" width="11" height="11">
    <path
      d="M3 5h18v10h-7v-2h5V7H5v2H3zM3 19h4a4 4 0 0 0-4-4zm0-3.5A3.5 3.5 0 0 1 6.5 19H8a5 5 0 0 0-5-5zm0-3A6.5 6.5 0 0 1 9.5 19H11A8 8 0 0 0 3 11z"
      fill="currentColor"
    />
  </svg>
)

// What the link is doing, said with one dot rather than an alarm. A mobile
// network that drops requests is a normal condition for a radio, not a failure:
// the music keeps playing on the device while this waits.
const LINK_NOTE = {
  degraded: 'the connection is dropping requests — playback continues, the radio is catching up',
  offline: 'no connection — the radio picks up where it left off as soon as it is back',
}

export default function OutputPill({ outputs, current, onSelect, onRefresh, link = 'online' }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)

  useEffect(() => {
    if (!open) return
    const away = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false)
    }
    const esc = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const label = current ? current.name : 'choose a device'
  const down = link === 'degraded' || link === 'offline'

  return (
    <div className="pill-wrap" ref={box}>
      <button
        className={`chip out${open ? ' on' : ''}${down ? ` link-${link}` : ''}`}
        onClick={() => {
          setOpen((o) => !o)
          if (!open && onRefresh) onRefresh() // the list goes stale fast
        }}
        title={down ? LINK_NOTE[link] : 'Where the audio plays — pick a Spotify device'}
      >
        <Cast />
        <span className="name">{label}</span>
        {down ? <span className="link-dot" aria-label={LINK_NOTE[link]} /> : null}
        <span className="caret">▾</span>
      </button>

      {open && (
        <div className="menu">
          {outputs && outputs.length ? (
            outputs.map((o) => (
              <button
                key={o.id}
                className={`row${current && current.id === o.id ? ' on' : ''}`}
                onClick={() => {
                  onSelect(o.id)
                  setOpen(false)
                }}
              >
                <span className="n">{o.name}</span>
                <span className="k">
                  {o.kind}
                  {o.active ? ' · active' : ''}
                </span>
              </button>
            ))
          ) : (
            <div className="empty">
              No device found. Open Spotify on a phone, desktop or speaker — it
              shows up here within seconds.
            </div>
          )}
          <button className="row refresh" onClick={() => onRefresh && onRefresh()}>
            <span className="n">refresh list</span>
          </button>
        </div>
      )}
    </div>
  )
}
