import React, { useRef } from 'react'
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
const Shuffle = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6h-2V7.4l-4.3 4.3-1.4-1.4L16.6 6H14zM4 17.6 9.6 12l1.4 1.4L5.4 19H4zM4 6.4 5.4 5l5.3 5.3-1.4 1.4zM18 16.6V14h2v6h-6v-2h2.6l-4.3-4.3 1.4-1.4z" />
  </svg>
)

// Three speaker states: muted, quiet, loud — the icon is the readout.
const Speaker = ({ level }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 9h3l4-3.5v13L7 15H4z" />
    {level > 0 && <path d="M14.5 8.6a5 5 0 0 1 0 6.8l1.1 1.1a6.6 6.6 0 0 0 0-9z" />}
    {level > 55 && <path d="M17.2 5.9a8.8 8.8 0 0 1 0 12.2l1.1 1.1a10.4 10.4 0 0 0 0-14.4z" />}
    {level === 0 && (
      <path d="M14.2 9.4l1.2-1.2 4.4 4.4-1.2 1.2z M18.6 9.4l1.2 1.2-4.4 4.4-1.2-1.2z" />
    )}
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

/**
 * Volume for whatever is playing — on Connect it drives the real device volume.
 * When the platform has no volume control at all (the Spotify preview embed does
 * not), the slider stays visible but disabled and says why: a dead control is
 * worse than an honest one.
 */
export function Volume({ value, available, onChange, unavailableReason, onUnavailable }) {
  const last = useRef(60)
  const level = value == null ? 60 : value
  const known = value != null
  const toggleMute = () => {
    if (!available) {
      if (onUnavailable) onUnavailable()
      return
    }
    if (level > 0) {
      last.current = level
      onChange(0)
    } else {
      onChange(last.current || 60)
    }
  }
  return (
    <div
      className={`volume${available ? '' : ' off'}${!available && onUnavailable ? ' askable' : ''}`}
      onClick={available ? undefined : onUnavailable}
      title={
        available
          ? `Volume ${known ? `${level}%` : ''} — click the speaker to mute`
          : unavailableReason || 'volume is not available on this player'
      }
    >
      {/* Not disabled when unavailable: a control that explains itself beats a
          dead one. The slider stays inert, the speaker answers. */}
      <button className="spk" onClick={toggleMute} aria-label={available ? 'Mute' : 'Why is volume off?'}>
        <Speaker level={available && known ? level : 0} />
      </button>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={level}
        disabled={!available}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        aria-label="Volume"
      />
    </div>
  )
}

export default function Controls({
  playing,
  onToggle,
  onNext,
  onReseed,
  volume,
  canSetVolume,
  onVolume,
  volumeReason,
  onVolumeUnavailable,
}) {
  return (
    <div className="controls">
      <div className="transport">
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
      <Volume
        value={volume}
        available={canSetVolume}
        onChange={onVolume}
        unavailableReason={volumeReason}
        onUnavailable={onVolumeUnavailable}
      />
    </div>
  )
}
