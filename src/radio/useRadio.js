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
  const [ruleset, setRulesetState] = useState(DEFAULT_RULESET)
  const [snapshot, setSnapshot] = useState({ playing: false, position: 0, duration: 0 })
  const [cover, setCover] = useState(null)
  const [notice, setNotice] = useState('')
  const [wantsPlay, setWantsPlay] = useState(false) // the user pressed play at least once

  const providersRef = useRef(null)
  const stationRef = useRef(null)
  const expectedRef = useRef(null) // platform ref we believe is on air
  const queuedRef = useRef(null) // platform ref already handed to the platform
  const busyRef = useRef(false)

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
      await completeLoginIfNeeded()
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
        setProviderId(preferredProviderId(providersRef.current, saved && saved.providerId))
        setNotice(loaded.notice || '')
        if (loaded.notice) setTimeout(() => alive && setNotice(''), 6000)
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
    provider.init().then(() => alive && rerender())
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
        rulesetId: ruleset.id,
      })
    }, 500)
    return () => clearTimeout(t)
  }, [phase, providerId, ruleset, snapshot.ref, snapshot.playing])

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

  const status = provider ? provider.status() : { available: false, authenticated: false, message: '' }

  return {
    phase,
    error,
    archive,
    notice: notice || (status.message || ''),

    provider,
    providers: providers || [],
    providerId: provider ? provider.id : null,
    switchProvider: (id) => {
      setProviderId(id)
      expectedRef.current = null
      queuedRef.current = null
      setSnapshot({ playing: false, position: 0, duration: 0 })
    },
    authenticate: () => provider && provider.authenticate && provider.authenticate(),
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

    play,
    pause,
    toggle,
    next,
    jumpTo,
    reseed,
    seek,
  }
}
