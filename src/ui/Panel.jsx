import React, { useMemo, useState } from 'react'
import { PRESETS, SCORERS, CONSTRAINTS } from '../core/rules.js'
import { searchTracks, archiveDuration, REMOTE_GRAPH_URL } from '../core/graph.js'
import { gLabel } from '../theme.js'
import { CAPS } from '../providers/index.js'

/* Everything that is not the cover lives behind one button. The panel is a
   list of small decisions: which station, which rules, which player, where to
   start. No graph, no charts — the map is the other project. */

function Slider({ name, desc, value, min, max, step, onChange, format }) {
  return (
    <label className="slider">
      <span className="name">{name}</span>
      <span className="val">{format ? format(value) : value}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {desc && <span className="desc">{desc}</span>}
    </label>
  )
}

export default function Panel({ radio, onClose }) {
  const [tab, setTab] = useState('station')
  const [q, setQ] = useState('')
  const index = radio.archive ? radio.archive.index : null
  const hits = useMemo(() => (index && q ? searchTracks(index, q, 10) : []), [index, q])
  const dur = useMemo(() => (index ? archiveDuration(index) : null), [index])
  const rs = radio.ruleset
  const devices = radio.provider && radio.provider.extras ? radio.provider.extras.devices : null

  const patch = (part) => radio.setRuleset({ ...rs, ...part })
  const patchWeights = (id, v) => radio.setRuleset({ ...rs, weights: { ...rs.weights, [id]: v } })
  const patchLimits = (id, v) => radio.setRuleset({ ...rs, limits: { ...rs.limits, [id]: v } })

  return (
    <div className="panel">
      <div className="head">
        <span className="wordmark">New Release Radio</span>
        <span className="spacer" />
        <button className="chip" onClick={onClose}>
          close ✕
        </button>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        {['station', 'rules', 'player', 'start'].map((t) => (
          <button key={t} className={`chip${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'station' && (
        <>
          <h2>Station</h2>
          <div className="row">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={`opt${rs.id === p.id ? ' on' : ''}`}
                onClick={() => radio.setRuleset(p)}
              >
                <div className="name">{p.label}</div>
                <div className="sub">{p.blurb}</div>
              </button>
            ))}
          </div>

          <h2>Just played</h2>
          <div>
            {radio.history.length ? (
              radio.history.map((h, i) => (
                <button key={`${h.node.id}-${i}`} className="hit" onClick={() => radio.jumpTo(h.node.id)}>
                  {h.node.title} <span>— {h.node.artist}</span>
                  {h.why && <span> · {h.why.text}</span>}
                </button>
              ))
            ) : (
              <p className="info">Nothing yet: the walk starts here.</p>
            )}
          </div>
        </>
      )}

      {tab === 'rules' && (
        <>
          <h2>Shape of the walk</h2>
          <Slider
            name="Variety"
            desc="0 always takes the best candidate; higher lets the walk surprise you."
            value={rs.temperature}
            min={0}
            max={1}
            step={0.02}
            onChange={(v) => patch({ temperature: v })}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            name="Memory"
            desc="How many just-played tracks pull on the next choice (1 = a strict chain)."
            value={rs.window}
            min={1}
            max={6}
            step={1}
            onChange={(v) => patch({ window: v })}
          />
          <Slider
            name="Genre stretch"
            desc="Preferred number of tracks before the walk looks for another genre."
            value={rs.targets.genreRun}
            min={1}
            max={14}
            step={1}
            onChange={(v) => radio.setRuleset({ ...rs, targets: { ...rs.targets, genreRun: v } })}
          />
          <Slider
            name="Artist spacing"
            desc="Minimum distance, in tracks, before the same artist can return."
            value={rs.limits.artistGap}
            min={1}
            max={40}
            step={1}
            onChange={(v) => patchLimits('artistGap', v)}
          />

          <h2>Rules</h2>
          {SCORERS.map((s) => (
            <Slider
              key={s.id}
              name={s.label}
              desc={s.describe}
              value={rs.weights[s.id] || 0}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(v) => patchWeights(s.id, v)}
              format={(v) => (v === 0 ? 'off' : v.toFixed(2))}
            />
          ))}

          <h2>Always enforced</h2>
          <p className="info">
            {CONSTRAINTS.map((c) => c.label).join(' · ')}. These are hard rules: they drop a candidate
            outright instead of scoring it. New rules go in{' '}
            <code>src/core/rules.js</code> — see <code>docs/RULES.md</code>.
          </p>
        </>
      )}

      {tab === 'player' && (
        <>
          <h2>Player</h2>
          <div className="row">
            {radio.providers.map((p) => (
              <button
                key={p.id}
                className={`opt${radio.providerId === p.id ? ' on' : ''}`}
                onClick={() => radio.switchProvider(p.id)}
              >
                <div className="name">{p.label}</div>
                <div className="sub">{p.blurb}</div>
              </button>
            ))}
          </div>

          {radio.provider && radio.provider.caps.has(CAPS.FULL) && !radio.status.authenticated && (
            <>
              <h2>Connect</h2>
              <button className="opt" onClick={radio.authenticate}>
                <div className="name">Connect Spotify</div>
                <div className="sub">
                  full tracks on your own device · Premium · login stays in your browser
                </div>
              </button>
            </>
          )}

          {devices && devices.length > 0 && (
            <>
              <h2>Play on</h2>
              <div className="row">
                {devices.map((d) => (
                  <button
                    key={d.id}
                    className={`opt${
                      radio.provider.extras.device && radio.provider.extras.device.id === d.id ? ' on' : ''
                    }`}
                    onClick={() => radio.provider.extras.select(d.id)}
                  >
                    <div className="name">{d.name}</div>
                    <div className="sub">{d.type.toLowerCase()}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {radio.provider && radio.provider.extras && radio.provider.extras.listDevices && (
            <p className="info" style={{ marginTop: 12 }}>
              <button className="chip" onClick={() => radio.provider.extras.listDevices()}>
                refresh devices
              </button>{' '}
              {radio.provider.signOut && radio.status.authenticated && (
                <button className="chip" onClick={() => radio.provider.signOut()}>
                  sign out
                </button>
              )}
            </p>
          )}

          {radio.provider && radio.provider.extras && radio.provider.extras.setSpeed && (
            <>
              <h2>Dry run speed</h2>
              <Slider
                name="Speed"
                desc="How fast the silent walk runs, for watching the rules work."
                value={radio.provider.extras.speed}
                min={1}
                max={120}
                step={1}
                onChange={(v) => radio.provider.extras.setSpeed(v)}
                format={(v) => `${v}×`}
              />
            </>
          )}
        </>
      )}

      {tab === 'start' && (
        <>
          <h2>Start somewhere</h2>
          <input
            className="search"
            placeholder="a track or an artist in the archive…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <div style={{ marginTop: 8 }}>
            {hits.map((n) => (
              <button
                key={n.id}
                className="hit"
                onClick={() => {
                  radio.reseed(n)
                  onClose()
                }}
              >
                {n.title} <span>— {n.artist} · {gLabel(n.genre)}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="opt"
              onClick={() => {
                radio.reseed()
                onClose()
              }}
            >
              <div className="name">Anywhere</div>
              <div className="sub">a random, well-connected track</div>
            </button>
          </div>

          <h2>Archive</h2>
          <p className="info">
            {radio.archive ? radio.archive.index.meta.unique_tracks : '—'} tracks ·{' '}
            {radio.archive ? radio.archive.index.meta.edges : '—'} links ·{' '}
            {radio.archive ? radio.archive.index.genres.length : '—'} genres
            {dur ? ` · ≈${dur.hours} h of music` : ''}
            <br />
            playlists {radio.archive ? radio.archive.index.meta.playlist_range : '—'} · updated{' '}
            {radio.archive ? radio.archive.index.meta.updated : '—'} · loaded from{' '}
            {radio.archive && radio.archive.source === 'remote' ? 'the live Atlas' : 'the bundled snapshot'}
            <br />
            <a href={REMOTE_GRAPH_URL.replace(/graph\.json$/, '')} target="_blank" rel="noreferrer">
              New Release Atlas — the map this radio walks
            </a>
          </p>
        </>
      )}
    </div>
  )
}
