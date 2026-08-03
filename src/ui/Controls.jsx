import React from 'react'
import { fmtTime } from '../theme.js'

const Play = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
)
const Pause = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
  </svg>
)
const Next = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 5l9 7-9 7zM17 5h2v14h-2z" />
  </svg>
)

/** Progress line. Draggable only when the provider can actually seek. */
export function ProgressBar({ position, duration, seekable, onSeek }) {
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0
  const jump = (e) => {
    if (!seekable || !duration) return
    const r = e.currentTarget.getBoundingClientRect()
    onSeek(((e.clientX - r.left) / r.width) * duration)
  }
  return (
    <div className="bar">
      <span>{fmtTime(position)}</span>
      <div className={`track${seekable ? ' seekable' : ''}`} onClick={jump}>
        <div className="rail">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span>{duration ? fmtTime(duration) : '—:—'}</span>
    </div>
  )
}

const Shuffle = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6h-2V7.4l-4.3 4.3-1.4-1.4L16.6 6H14zM4 17.6 9.6 12l1.4 1.4L5.4 19H4zM4 6.4 5.4 5l5.3 5.3-1.4 1.4zM18 16.6V14h2v6h-6v-2h2.6l-4.3-4.3 1.4-1.4z" />
  </svg>
)

export default function Controls({ playing, onToggle, onNext, onReseed }) {
  return (
    <div className="controls">
      <button className="ctl" onClick={onReseed} title="New station — start somewhere else">
        <Shuffle />
      </button>
      <button className="ctl main" onClick={onToggle} title={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause /> : <Play />}
      </button>
      <button className="ctl" onClick={onNext} title="Next track — the walk moves on">
        <Next />
      </button>
    </div>
  )
}
