import React, { useEffect, useRef, useState } from 'react'
import { useRadio } from './radio/useRadio.js'
import { CAPS } from './providers/index.js'
import Cover from './ui/Cover.jsx'
import Controls, { ProgressBar } from './ui/Controls.jsx'
import Panel from './ui/Panel.jsx'
import { gColor, gLabel } from './theme.js'

/* One screen: the cover of what is playing, the two lines that name it, the
   reason the walk chose it, and three buttons. Everything else is behind the
   station chip. */

export default function App() {
  const radio = useRadio()
  const [panel, setPanel] = useState(false)
  const hostRef = useRef(null)

  const node = radio.current
  const genre = node ? node.genre : null

  // The genre tints the whole room (dot, progress line, ambient glow).
  useEffect(() => {
    document.documentElement.style.setProperty('--genre', gColor(genre))
  }, [genre])

  // The preview provider needs a DOM host for the official iframe player.
  const provider = radio.provider
  const needsHost = !!(provider && provider.mount)
  useEffect(() => {
    if (!needsHost || !hostRef.current) return
    provider.mount(hostRef.current)
    return () => provider.unmount && provider.unmount()
  }, [provider, needsHost])

  // Space toggles playback, → skips: a radio should be usable without looking.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return
      if (e.code === 'Space') {
        e.preventDefault()
        radio.toggle()
      } else if (e.code === 'ArrowRight') radio.next()
      else if (e.key === 's') setPanel((p) => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [radio])

  if (radio.phase === 'loading') return <div className="center">tuning in…</div>
  if (radio.phase === 'error')
    return (
      <div className="center">
        {radio.error}
        <br />
        the radio needs the New Release Atlas archive to walk.
      </div>
    )

  const upNext = radio.upNext[0]
  const isPreview = !!(provider && provider.caps.has(CAPS.PREVIEW))

  return (
    <div className="screen">
      <div
        className="ambient"
        style={radio.cover ? { backgroundImage: `url(${radio.cover.url})` } : undefined}
      />

      <div className="topbar">
        <span className="wordmark">New Release Radio</span>
        <span className="spacer" />
        <button className="chip accent" onClick={() => setPanel(true)}>
          {radio.ruleset.label}
        </button>
        <button className="chip" onClick={() => setPanel(true)} title={provider ? provider.blurb : ''}>
          {provider ? provider.label : '—'}
          {radio.status.device ? ` · ${radio.status.device}` : ''}
        </button>
      </div>

      <div className="stage">
        <Cover
          cover={radio.cover}
          node={node}
          started={radio.started}
          playing={radio.playing}
          onPlay={radio.play}
        />

        <div className="meta">
          <div className="title">{node ? node.title : '—'}</div>
          <div className="artist">{node ? (node.artists || [node.artist]).join(', ') : ''}</div>
          <div className="why">
            <span className="dot" />
            {gLabel(genre)}
            {node && node.bpm ? ` · ${node.bpm} bpm` : ''}
            {radio.why && radio.why.kind !== 'seed' ? ` · ${radio.why.text}` : ''}
          </div>
        </div>

        <ProgressBar
          position={radio.progress.position}
          duration={radio.progress.duration}
          seekable={!!(provider && provider.caps.has(CAPS.SEEK))}
          onSeek={radio.seek}
        />

        <Controls
          playing={radio.playing}
          onToggle={radio.toggle}
          onNext={radio.next}
          onReseed={() => radio.reseed()}
        />

        {/* Spotify plays the preview: the official player stays on screen, quiet. */}
        {needsHost && <div ref={hostRef} className={`embed${isPreview ? '' : ' hidden'}`} />}
      </div>

      {radio.notice ? <div className="notice">{radio.notice}</div> : null}

      <div className="footer">
        <span className="label">next</span>
        <button
          className="next"
          onClick={radio.next}
          title="skip to it"
          disabled={!upNext}
        >
          {upNext ? (
            <>
              {upNext.node.title} — {upNext.node.artist}
              <span style={{ color: 'var(--dim)' }}>
                {upNext.why ? ` · ${upNext.why.text}` : ''}
              </span>
            </>
          ) : (
            '…'
          )}
        </button>
        <span className="label" title="tracks into this walk">
          #{radio.position + 1}
        </span>
      </div>

      {panel && <Panel radio={radio} onClose={() => setPanel(false)} />}
    </div>
  )
}
