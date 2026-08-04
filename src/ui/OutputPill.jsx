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

export default function OutputPill({ outputs, current, onSelect, onRefresh }) {
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

  return (
    <div className="pill-wrap" ref={box}>
      <button
        className={`chip out${open ? ' on' : ''}`}
        onClick={() => {
          setOpen((o) => !o)
          if (!open && onRefresh) onRefresh() // the list goes stale fast
        }}
        title="Where the audio plays — pick a Spotify device"
      >
        <Cast />
        <span className="name">{label}</span>
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
