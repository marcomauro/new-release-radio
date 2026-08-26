import React, { useEffect, useRef, useState } from 'react'
import { useRadio } from './radio/useRadio.js'
import { CAPS } from './providers/index.js'
import Cover from './ui/Cover.jsx'
import Controls, { ProgressBar } from './ui/Controls.jsx'
import OutputPill from './ui/OutputPill.jsx'
import ConnectPill from './ui/ConnectPill.jsx'
import Panel from './ui/Panel.jsx'
import { gColor, gLabel } from './theme.js'

/* One screen: the cover of what is playing, the two lines that name it, the
   reason the walk chose it, and one set of controls. Everything else is behind
   a chip.

   There is exactly ONE player on this page — ours. When previews are the source,
   Spotify's iframe still does the decoding, but it is caged (see `.embed-cage`:
   the iFrame API replaces the element it is given, so the cage is what carries
   the styling) and driven entirely by the controls below. */

// Touch + no hover: a phone or a tablet. Used for the one decision that really
// differs there — Connect first, previews as a named fallback.
const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: none) and (pointer: coarse)').matches

export default function App() {
  const radio = useRadio()
  const [panel, setPanel] = useState(false)
  const [touch] = useState(isTouchDevice)
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

  // The volume is pointless on a phone playing to itself (Spotify refuses the
  // command, the buttons on the side already do it) and useful the moment the
  // stream is on a speaker or a computer. So on touch it follows the output.
  const showVolume = !touch || (!!radio.currentOutput && !radio.outputIsHandset)

  return (
    <div className="screen">
      <div
        className="ambient"
        style={radio.cover ? { backgroundImage: `url(${radio.cover.url})` } : undefined}
      />

      <div className="topbar">
        <span className="wordmark">New Release Radio</span>
        <span className="spacer" />
        {/* Devices when connected; the way in when not. One of the two is
            always there, so the main screen never dead-ends. */}
        {radio.canChooseOutput ? (
          <OutputPill
            outputs={radio.outputs}
            current={radio.currentOutput}
            onSelect={radio.selectOutput}
            onRefresh={radio.refreshOutputs}
            link={radio.link}
          />
        ) : radio.canConnect ? (
          <ConnectPill onConnect={radio.connectSpotify} />
        ) : null}
        <button className="chip accent" onClick={() => setPanel(true)} title="Station rules">
          {radio.ruleset.label}
        </button>
        <button className="chip" onClick={() => setPanel(true)} title={provider ? provider.blurb : ''}>
          {/* Both labels ship; CSS picks one by width, so no resize listener. */}
          <span className="wide">{provider ? provider.label : '—'}</span>
          <span className="narrow">{provider ? provider.shortLabel || provider.label : '—'}</span>
        </button>
      </div>

      <div className="stage">
        <Cover
          cover={radio.cover}
          node={node}
          started={radio.started}
          playing={radio.playing}
          onPlay={radio.play}
          connectFirst={touch && isPreview && radio.canConnect}
          onConnect={radio.connectSpotify}
          why={radio.why}
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
          volume={radio.volume}
          canSetVolume={radio.canSetVolume}
          onVolume={radio.setVolume}
          volumeReason={
            radio.volumeNote ||
            (isPreview
              ? 'the Spotify preview player has no volume control — connect Spotify for full tracks and volume'
              : 'this player does not expose a volume control')
          }
          onVolumeUnavailable={radio.explainVolume}
          showVolume={showVolume}
        />

        {/* Spotify decodes the preview. The API replaces the inner element with
            its own iframe, so the CAGE carries the styling that keeps it out of
            sight — otherwise Spotify's player lands in the layout with its own
            controls. Ours are the only ones on screen. */}
        {needsHost && (
          <div className="embed-cage" aria-hidden="true">
            <div ref={hostRef} />
          </div>
        )}
      </div>

      {radio.notice ? <div className="notice">{radio.notice}</div> : null}

      <div className="footer">
        <span className="label">next</span>
        <button className="next" onClick={radio.next} title="skip to it" disabled={!upNext}>
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
