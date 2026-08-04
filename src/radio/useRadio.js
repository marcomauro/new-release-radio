/* ----------------------------------------------------------------------------
   radio/useRadio.js — the engine: it wires the walk to a provider.

   The one place where "what plays next" (core/) meets "how it is heard"
   (providers/). Two ways to keep the stream endless, chosen from the provider's
   capabilities:

   • CAPS.QUEUE (Spotify Connect) — playback is started once and the next track
     is appended to the platform's own queue. The provider's poll() tells us
     what is actually on air; when it changes we commit that step of the walk
     and append a new one. If the user (or Spotify) plays something we did not
     choose, the walk MOVES ONTO IT instead of fighting: whatever is playing
     becomes the current node.

   • no QUEUE (previews, dry run) — we advance ourselves when poll() reports the
     track ended, and start the next one.

   Joining a session that is already running is a first-class case, not an edge
   case: on load, if Spotify is already playing, the radio adopts that session
   (no restart) and — when the track is in the archive — continues the walk from
   it. That is the difference between a remote control and a second player.

   The hook owns no music logic. Rules live in core/rules.js.
   -------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadArchive } from '../core/graph.js'
import { createStation, randomSeed } from '../core/walker.js'
import { DEFAULT_RULESET, presetById } from '../core/rules.js'
import { createProviders, preferredProviderId, CAPS } from '../providers/index.js'
import { completeLoginIfNeeded, isLoggedIn } from '../providers/spotify/auth.js'
import { prefetchCovers } from '../providers/spotify/artwork.js'

const LS_SESSION = 'nrr_session_v1'
const POLL_MS = { queue: 2500, local: 400 }
const VOLUME_DEBOUNCE_MS = 220
// After a local volume change, ignore the platform's reported level for a
// moment: Spotify answers with the old value for a beat and the slider jumps.
const VOLUME_HOLD_MS = 1800

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(LS_SESSION) || 'null')
  } catch (e) {
    return null
  }
}

function writeSession(data) {
  try {
    localStorage.setItem(LS_SESSION, JSON.stringify(data))
  } catch (e) {
    /* private mode */
  }
}

export function useRadio() {
  const [phase, setPhase] = useState('loading') // loading | ready | error
  const [error, setError] = useState('')
  const [archive, setArchive] = useState(null) // { index, source, notice }
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])

  const [providerId, setProviderId] = useState(null)
  const [providerPinned, setProviderPinned] = useState(false)
  const [ruleset, setRulesetState] = useState(DEFAULT_RULESET)
  const [snapshot, setSnapshot] = useState({ playing: false, position: 0, duration: 0 })
  const [cover, setCover] = useState(null)
  const [notice, setNotice] = useState('')
  const [wantsPlay, setWantsPlay] = useState(false) // the user pressed play at least once
  const [volume, setVolumeState] = useState(null) // 0-100, null = unknown
  const [outputs, setOutputs] = useState([])

  const providersRef = useRef(null)
  const stationRef = useRef(null)
  const expectedRef = useRef(null) // platform ref we believe is on air
  const queuedRef = useRef(null) // platform ref already handed to the platform
  const busyRef = useRef(false)
  const adoptedRef = useRef(false) // did we already look for a running session?
  const justLoggedInRef = useRef(false)
  const loginErrorRef = useRef('')
  const volumeTimer = useRef(null)
  const volumeTouchedAt = useRef(0)

  const providers = providersRef.current
  const provider = useMemo(
    () => (providers ? providers.find((p) => p.id === providerId) || providers[0] : null),
    [providers, providerId]
  )

  /* --- boot: archive + providers + station ------------------------------- */

  useEffect(() => {
    let alive = true
    ;(async () => {
      // finish a pending OAuth redirect before anything reads the token
      const login = await completeLoginIfNeeded()
      justLoggedInRef.current = login.completed
      loginErrorRef.current = login.error
      if (!providersRef.current) providersRef.current = createProviders()
      try {
        const loaded = await loadArchive()
        if (!alive) return
        const saved = readSession()
        const rules = presetById(saved && saved.rulesetId)
        const askedTrack =
          new URLSearchParams(window.location.search).get('track') ||
          new URLSearchParams(window.location.search).get('seed')
        const seedNode =
          (askedTrack && loaded.index.node(askedTrack)) || randomSeed(loaded.index)
        const station = createStation({ index: loaded.index, ruleset: rules, seedNode })
        if (!askedTrack && saved && saved.station) station.restore(saved.station)
        stationRef.current = station
        setArchive(loaded)
        setRulesetState(rules)
        setProviderId(preferredProviderId(providersRef.current, saved))
        setProviderPinned(!!(saved && saved.providerPinned))
        // A refused login outranks any other notice: it is the one failure the
        // user cannot diagnose alone. The usual cause is a deployment URL that
        // is not registered as a redirect URI in the Spotify app.
        if (loginErrorRef.current) {
          setNotice(
            `Spotify refused the login (${loginErrorRef.current}) — this address must be registered ` +
              `as a redirect URI in the Spotify app settings`
          )
        } else {
          setNotice(loaded.notice || '')
          if (loaded.notice) setTimeout(() => alive && setNotice(''), 6000)
        }
        setPhase('ready')
      } catch (e) {
        if (!alive) return
        setError(e.message || 'could not load the archive')
        setPhase('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /* --- keep the view in step with the walk ------------------------------- */

  useEffect(() => {
    const st = stationRef.current
    if (!st) return
    return st.subscribe(rerender)
  }, [phase, rerender])

  /* --- provider lifecycle ----------------------------------------------- */

  useEffect(() => {
    if (!provider) return
    let alive = true
    provider.init().then(() => {
      if (!alive) return
      if (provider.caps.has(CAPS.OUTPUTS) && provider.outputs) {
        setOutputs([...provider.outputs()])
        // The device list already carries its volume: show the real level
        // before the first poll instead of a made-up default.
        const cur = provider.currentOutput && provider.currentOutput()
        if (cur && cur.volume != null) setVolumeState(cur.volume)
      }
      rerender()
    })
    return () => {
      alive = false
      if (provider.teardown) provider.teardown()
      expectedRef.current = null
      queuedRef.current = null
    }
  }, [provider, rerender])

  /* --- persistence ------------------------------------------------------ */

  useEffect(() => {
    if (phase !== 'ready' || !stationRef.current) return
    const t = setTimeout(() => {
      writeSession({
        station: stationRef.current.serialize(),
        providerId,
        providerPinned,
        rulesetId: ruleset.id,
      })
    }, 500)
    return () => clearTimeout(t)
  }, [phase, providerId, providerPinned, ruleset, snapshot.ref, snapshot.playing])

  /* --- the loop --------------------------------------------------------- */

  const canQueue = !!(provider && provider.caps.has(CAPS.QUEUE))

  const station = stationRef.current

  // Hand the next decided track to a queue-capable platform (once).
  const topUpQueue = useCallback(async () => {
    if (!canQueue || !provider || !station) return
    const upcoming = station.upNext(1)[0]
    if (!upcoming) return
    const ref = await provider.resolve(upcoming.node)
    if (!ref || queuedRef.current === ref) return
    const ok = await provider.enqueue(upcoming.node)
    if (ok) queuedRef.current = ref
  }, [canQueue, provider, station])

  const startCurrent = useCallback(async () => {
    if (!provider || !station || !station.current) return
    const ref = await provider.resolve(station.current)
    expectedRef.current = ref
    queuedRef.current = null
    await provider.start(station.current)
    await topUpQueue()
    rerender()
  }, [provider, station, topUpQueue, rerender])

  // advance the walk without touching the platform (it already moved on)
  const commitTo = useCallback(
    (node, ref) => {
      expectedRef.current = ref
      queuedRef.current = null
      setCover(null)
      rerender()
    },
    [rerender]
  )

  /* --- join a Spotify session that is already running -------------------- */

  useEffect(() => {
    if (phase !== 'ready' || !provider || !station || !archive || adoptedRef.current) return
    if (!canQueue || !provider.status().authenticated) return
    let alive = true
    ;(async () => {
      const snap = await provider.poll()
      if (!alive) return
      adoptedRef.current = true
      if (!snap || !snap.ref) {
        // Nothing on air. Coming straight back from the login redirect, the
        // intent was unmistakably "play": Connect puts the audio on the device,
        // not in this tab, so no autoplay policy is in the way.
        if (justLoggedInRef.current) {
          justLoggedInRef.current = false
          setWantsPlay(true)
          await startCurrent()
        }
        return
      }
      if (provider.adopt) provider.adopt(snap.ref)
      expectedRef.current = snap.ref
      setSnapshot(snap)
      if (snap.artwork) setCover(snap.artwork)
      const id = provider.trackIdFromRef ? provider.trackIdFromRef(snap.ref) : null
      const node = id ? archive.index.node(id) : null
      if (node) {
        if (!station.current || station.current.id !== node.id) station.jumpTo(node.id, 'device')
        setNotice(`picked up your Spotify session — walking on from “${node.title}”`)
      } else {
        setNotice('Spotify is playing something outside the archive — press ▶ to start the walk')
      }
      setTimeout(() => alive && setNotice(''), 7000)
      if (snap.playing) setWantsPlay(true) // the loop takes it from here
      rerender()
    })()
    return () => {
      alive = false
    }
  }, [phase, provider, station, archive, canQueue, startCurrent, rerender])

  useEffect(() => {
    if (phase !== 'ready' || !provider || !station || !wantsPlay) return
    let alive = true
    const every = canQueue ? POLL_MS.queue : POLL_MS.local

    const tick = async () => {
      if (!alive || busyRef.current) return
      busyRef.current = true
      try {
        const snap = await provider.poll()
        if (!alive) return
        setSnapshot(snap)
        if (snap.artwork) setCover(snap.artwork)
        if (snap.volume != null && Date.now() - volumeTouchedAt.current > VOLUME_HOLD_MS) {
          setVolumeState(snap.volume)
        }

        if (canQueue) {
          const ref = snap.ref
          if (ref && ref !== expectedRef.current) {
            const upcoming = station.upNext(1)[0]
            const upcomingRef = upcoming ? await provider.resolve(upcoming.node) : null
            if (upcomingRef && ref === upcomingRef) {
              station.advance() // our own choice started playing
              commitTo(upcoming.node, ref)
            } else {
              // something else is on air: follow it if we know the track
              const id = provider.trackIdFromRef ? provider.trackIdFromRef(ref) : null
              const node = id && archive ? archive.index.node(id) : null
              if (node) {
                station.jumpTo(node.id, 'device')
                commitTo(node, ref)
                setNotice('')
              } else {
                setNotice('playing something outside the archive — the walk is paused here')
                expectedRef.current = ref
              }
            }
          } else if (ref) {
            await topUpQueue()
          }
        } else if (snap.endedRef && snap.endedRef === expectedRef.current) {
          station.advance()
          await startCurrent()
        }
      } finally {
        busyRef.current = false
      }
    }

    tick()
    const h = setInterval(tick, every)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [phase, provider, station, wantsPlay, canQueue, archive, commitTo, startCurrent, topUpQueue])

  /* --- cover art -------------------------------------------------------- */

  const currentId = station && station.current ? station.current.id : null

  useEffect(() => {
    if (!provider || !station || !currentId) return
    let alive = true
    setCover(null)
    provider.artwork(station.current).then((c) => {
      if (alive && c) setCover(c)
    })
    // warm the covers of what the walk has already decided
    prefetchCovers(
      station.upNext(2).map((u) => u.node.id),
      { authenticated: isLoggedIn() && provider.id === 'spotify-connect' }
    )
    return () => {
      alive = false
    }
  }, [provider, station, currentId])

  /* --- actions ---------------------------------------------------------- */

  const play = useCallback(async () => {
    setWantsPlay(true)
    if (!provider || !station) return
    if (snapshot.ref && snapshot.ref === expectedRef.current && !snapshot.playing) {
      await provider.resume()
    } else {
      await startCurrent()
    }
  }, [provider, station, snapshot.ref, snapshot.playing, startCurrent])

  const pause = useCallback(async () => {
    if (provider) await provider.pause()
    setSnapshot((s) => ({ ...s, playing: false }))
  }, [provider])

  const toggle = useCallback(() => {
    if (snapshot.playing) pause()
    else play()
  }, [snapshot.playing, pause, play])

  /** Next track. On a queue platform the queued track is already there. */
  const next = useCallback(async () => {
    if (!provider || !station) return
    setWantsPlay(true)
    if (canQueue && provider.skip) {
      station.noteSkip(false) // the platform will play what we queued
      const ok = await provider.skip()
      if (ok) {
        // the poll will see the new track and commit the step
        rerender()
        return
      }
    }
    station.skip()
    await startCurrent()
  }, [provider, station, canQueue, startCurrent, rerender])

  const jumpTo = useCallback(
    async (id) => {
      if (!station) return
      setWantsPlay(true)
      station.jumpTo(id)
      await startCurrent()
    },
    [station, startCurrent]
  )

  const reseed = useCallback(
    async (node) => {
      if (!station || !archive) return
      station.reseed(node || randomSeed(archive.index))
      setWantsPlay(true)
      await startCurrent()
    },
    [station, archive, startCurrent]
  )

  /**
   * Connect Spotify from anywhere, whatever provider is on air. The preview
   * provider has no authenticate() of its own, so asking the *current* provider
   * to log in was a dead end: this reaches into the registry for the one that
   * can play full tracks.
   */
  const connectSpotify = useCallback(() => {
    const list = providersRef.current || []
    const full = list.find((p) => p.caps.has(CAPS.FULL) && p.authenticate)
    if (full) full.authenticate()
  }, [])

  const setRuleset = useCallback(
    (next) => {
      const rules = typeof next === 'string' ? presetById(next) : next
      setRulesetState(rules)
      if (station) station.setRuleset(rules)
      // A queue platform already holds one track decided by the old rules: let
      // it play and let the walk re-decide from there (one track of lag, no
      // interruption) rather than stacking a second choice behind it.
      rerender()
    },
    [station, rerender]
  )

  const seek = useCallback(
    async (ms) => {
      if (provider && provider.caps.has(CAPS.SEEK)) await provider.seek(ms)
    },
    [provider]
  )

  /** Volume: instant on the slider, debounced on the wire. */
  const setVolume = useCallback(
    (percent) => {
      const v = Math.max(0, Math.min(100, Math.round(percent)))
      setVolumeState(v)
      volumeTouchedAt.current = Date.now()
      if (!provider || !provider.caps.has(CAPS.VOLUME) || !provider.setVolume) return
      if (volumeTimer.current) clearTimeout(volumeTimer.current)
      volumeTimer.current = setTimeout(() => {
        volumeTimer.current = null
        provider.setVolume(v)
      }, VOLUME_DEBOUNCE_MS)
    },
    [provider]
  )

  /* --- outputs (where the audio comes out) ------------------------------ */

  const refreshOutputs = useCallback(async () => {
    if (!provider || !provider.caps.has(CAPS.OUTPUTS) || !provider.listOutputs) return []
    const list = await provider.listOutputs()
    setOutputs([...(list || [])])
    rerender()
    return list
  }, [provider, rerender])

  const selectOutput = useCallback(
    async (id) => {
      if (!provider || !provider.selectOutput) return
      await provider.selectOutput(id)
      await refreshOutputs()
      // Moving the stream keeps it playing: make sure the loop is watching.
      setWantsPlay(true)
    },
    [provider, refreshOutputs]
  )

  const switchProvider = useCallback(
    (id) => {
      if (!id || id === providerId) return
      // Never leave two players running: silence the one we are leaving.
      if (provider && provider.pause) provider.pause()
      setProviderId(id)
      setProviderPinned(true) // an explicit choice, remembered as such
      adoptedRef.current = false // the new provider may have a live session too
      expectedRef.current = null
      queuedRef.current = null
      setOutputs([])
      setVolumeState(null)
      setSnapshot({ playing: false, position: 0, duration: 0 })
    },
    [provider, providerId]
  )

  const status = provider ? provider.status() : { available: false, authenticated: false, message: '' }

  // Is there a full-track player waiting behind a login?
  const canConnect = !!(providers || []).some(
    (p) => p.caps.has(CAPS.FULL) && p.authenticate && !p.status().authenticated
  )

  // Why the volume is dead, said out loud when the user reaches for it.
  const explainVolume = useCallback(() => {
    setNotice(
      canConnect
        ? 'the Spotify preview player has no volume control — connect Spotify (top right) for full tracks, volume and device choice'
        : 'this player has no volume control'
    )
    setTimeout(() => setNotice(''), 7000)
  }, [canConnect])

  // Logged in but listening to previews: say it once, quietly, instead of
  // silently serving 30-second clips to someone with a Premium session.
  const hint =
    !canQueue && isLoggedIn() && provider && provider.id !== 'spotify-connect'
      ? 'Spotify is connected — switch the player to Connect for full tracks'
      : ''

  return {
    phase,
    error,
    archive,
    notice: notice || status.message || hint,

    provider,
    providers: providers || [],
    providerId: provider ? provider.id : null,
    switchProvider,
    authenticate: () => provider && provider.authenticate && provider.authenticate(),
    connectSpotify,
    canConnect,
    explainVolume,
    signOut: () => {
      if (provider && provider.signOut) provider.signOut()
      setOutputs([])
      rerender()
    },
    status,

    ruleset,
    setRuleset,

    current: station ? station.current : null,
    why: station ? station.currentWhy : null,
    upNext: station ? station.upNext(2) : [],
    history: station ? station.history(12) : [],
    position: station ? station.position : 0,
    cover,
    playing: snapshot.playing,
    progress: { position: snapshot.position || 0, duration: snapshot.duration || 0 },
    started: wantsPlay,

    // volume
    volume,
    canSetVolume: !!(provider && provider.caps.has(CAPS.VOLUME)) && snapshot.volumeAvailable !== false,
    setVolume,

    // outputs
    outputs,
    currentOutput: provider && provider.currentOutput ? provider.currentOutput() : null,
    canChooseOutput: !!(provider && provider.caps.has(CAPS.OUTPUTS) && status.authenticated),
    refreshOutputs,
    selectOutput,

    play,
    pause,
    toggle,
    next,
    jumpTo,
    reseed,
    seek,
  }
}
