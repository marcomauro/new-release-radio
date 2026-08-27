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

   **Backgrounded phones.** A mobile browser freezes timers as soon as the app
   leaves the screen, so a radio that keeps only ONE track queued on the
   platform goes dry within minutes and Spotify starts its own autoplay — the
   walk silently stops being the thing you are hearing. So the queue is deeper
   while the page is hidden, and on return the walk fast-forwards over the
   tracks that played while we were asleep instead of losing them.

   **A network that comes and goes.** The hard case is not a network that is
   down, it is one that answers sometimes. Four rules keep the radio honest
   there, and all four exist because of a real bug:

   1. A snapshot marked `stale` is merged onto the last known state, never over
      it, and the position is carried forward from the local clock. A lost
      request used to arrive as "nothing is playing", which put a ▶ on screen
      while Spotify was playing and made the next tap restart the track.
   2. No command is sent from a state we know to be stale. `play()` re-syncs
      first and gives up rather than guess.
   3. The platform's queue is topped up during an outage too, and our record of
      what it holds is reconciled against what Spotify itself reports. A dry
      queue is how the station gets handed to Spotify's autoplay.
   4. The user's own intents (volume, moving the stream to another device) are
      remembered while the network is gone and replayed when it returns.
      Playback commands never are: a duplicate `next` is audible, and a lost
      answer cannot be told from a lost request.

   **A stream that ran out.** The queue can still empty — a phone hidden longer
   than the horizon, an outage longer than the music we had handed over. When it
   does, the platform stops, and because the station starts a ONE-TRACK context a
   player that falls back to its context lands on the first track of the session.
   The radio used to notice none of this: `wantsPlay` was true, the poll said
   `playing: false`, and no rule acted on it — so the music stopped and stayed
   stopped, on the first track. It now recognises the case (stopped at position
   ~0 with nothing of ours left on the platform), advances the walk past
   everything that played while it was blind, and starts the next track. A pause
   anywhere else in a track is somebody pressing pause, and pause is sacred.

   **Two radios, one account.** A phone and a desktop can both be running this
   app against the same Spotify account, and there is no lock to take: the two
   devices share nothing but Spotify. So another instance is DETECTED — from a
   platform queue holding archive tracks we never handed over — and the radio
   stands down and asks who should steer, rather than fighting it or silently
   stopping being the thing you hear.

   The hook owns no music logic. Rules live in core/rules.js.
   -------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadArchive } from '../core/graph.js'
import { createStation, randomSeed } from '../core/walker.js'
import { DEFAULT_RULESET, presetById } from '../core/rules.js'
import { createProviders, preferredProviderId, CAPS } from '../providers/index.js'
import { makeSnapshot } from '../providers/provider.js'
import { completeLoginIfNeeded, isLoggedIn } from '../providers/spotify/auth.js'
import { prefetchCovers } from '../providers/spotify/artwork.js'

const LS_SESSION = 'nrr_session_v1'

// How often we ask what is on air. Slower when the answers stop coming: there
// is nothing to learn from hammering a dead connection, and a phone in a pocket
// pays for every attempt in battery.
const POLL_MS = { queue: 2500, local: 400, degraded: 6000, offline: 15000 }

// One stale answer is a hiccup; three in a row is an outage.
const DEGRADED_AFTER = 1
const OFFLINE_AFTER = 3

// How many decided tracks may sit in the platform's own queue.
//
// One when everything is fine and the app is on screen: the rules panel stays
// responsive — change a rule and it applies to the very next track.
// More when we cannot count on being asked again soon (hidden, or a network
// that is dropping requests), sized by TIME rather than by count: what matters
// is that the stream does not run out and hand the session to Spotify's
// autoplay, and a two-minute track buys half of what a five-minute one does.
const QUEUE_DEPTH = { visible: 1, max: 6 }
const HORIZON_MS = { hidden: 10 * 60 * 1000, degraded: 8 * 60 * 1000 }
const FALLBACK_TRACK_MS = 210 * 1000

// The walk decides this far ahead, which bounds both the queue depth and the
// window we search when we come back to find Spotify several tracks on.
const LOOKAHEAD = 12
const RECONCILE_WINDOW = 12

// How long a held position may keep moving on the local clock. Past this the
// track has probably ended and we are guessing: the clock stops instead.
const POSITION_TRUST_MS = 45000

// A tick that has not finished by now is abandoned rather than allowed to hold
// the loop. The transport's own budget is well under this; the watchdog is for
// whatever it fails to bound.
const WATCHDOG_MS = 18000

// Our record of the platform's queue is re-checked against the platform this
// often — and always right after the network comes back.
const QUEUE_AUDIT_MS = 20000

// After recovering an exhausted stream, wait this long before doing it again.
// A restart that does not take must not become a loop of restarts.
const RECOVERY_COOLDOWN_MS = 15000
// A stop at the very beginning of a track is the platform running out; a stop
// anywhere else is somebody pressing pause.
const RAN_OUT_POSITION_MS = 2000

const OUTBOX_MAX = 8
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

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false

/**
 * The last known playback state, carried forward. Everything the provider could
 * not tell us stays as it was; only the position moves, and only for as long as
 * moving it is honest.
 */
function holdOver(good, message) {
  const base = good && good.snap
  if (!base) return makeSnapshot({ message, stale: true })
  const gap = Math.min(Date.now() - good.at, POSITION_TRUST_MS)
  const position = base.playing
    ? Math.min(base.duration || Number.MAX_SAFE_INTEGER, (base.position || 0) + gap)
    : base.position || 0
  // `endedRef` must not survive: it is an event, and repeating it would advance
  // the walk once per failed poll.
  return { ...base, position, endedRef: null, message, stale: true }
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
  // Set when the platform refuses a volume command. Kept here, not waited for
  // from the next poll, so the control stops offering itself immediately.
  const [volumeNote, setVolumeNote] = useState('')
  const [outputs, setOutputs] = useState([])
  // online | degraded | offline — what we currently believe about the link.
  const [link, setLinkState] = useState('online')
  // Bumped to try the session adopt again when the first attempt got no answer.
  const [adoptAttempt, setAdoptAttempt] = useState(0)
  // Another instance of this radio appears to be driving the same account.
  // `driving` is us: while it is false we send NOTHING and only follow along.
  const [contended, setContended] = useState(false)
  const [driving, setDriving] = useState(true)

  const providersRef = useRef(null)
  const stationRef = useRef(null)
  const expectedRef = useRef(null) // platform ref we believe is on air
  const queuedRefs = useRef([]) // platform refs the platform holds, in order
  const handedOver = useRef(new Set()) // every ref we gave it since the last start
  const outbox = useRef([]) // user intents lost to the network, to replay
  const snapRef = useRef({ playing: false, position: 0, duration: 0 })
  const lastGood = useRef(null) // { snap, at } — the newest answer we trust
  const failStreak = useRef(0)
  const linkRef = useRef('online')
  const tickRef = useRef(null) // the poll body, so we can fire it on demand
  const busyRef = useRef(false)
  const busySince = useRef(0)
  const lastAuditAt = useRef(0)
  const pausedByUs = useRef(false) // we asked for the pause, so do not undo it
  const hasPlayed = useRef(false) // the platform has actually played at least once
  const lastRecoveryAt = useRef(0)
  const drivingRef = useRef(true) // read inside the loop, which does not re-close
  // After taking over, give the other instance time to notice and stand down
  // before accusing it again — otherwise the two of them ping-pong the question.
  const contendQuietUntil = useRef(0)
  const adoptedRef = useRef(false) // did we already look for a running session?
  const justLoggedInRef = useRef(false)
  const loginErrorRef = useRef('')
  const volumeTimer = useRef(null)
  const volumeTouchedAt = useRef(0)
  const noticeTimer = useRef(null)

  const providers = providersRef.current
  const provider = useMemo(
    () => (providers ? providers.find((p) => p.id === providerId) || providers[0] : null),
    [providers, providerId]
  )

  /** A notice that goes away on its own, and never fights a newer one. */
  const flash = useCallback((text, ms = 7000) => {
    setNotice(text)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      setNotice('')
    }, ms)
  }, [])

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
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
        const station = createStation({
          index: loaded.index,
          ruleset: rules,
          seedNode,
          lookahead: LOOKAHEAD,
        })
        if (!askedTrack && saved && saved.station) station.restore(saved.station)
        stationRef.current = station
        setArchive(loaded)
        setRulesetState(rules)
        setProviderId(preferredProviderId(providersRef.current, saved))
        setProviderPinned(!!(saved && saved.providerPinned))
        // A refused login outranks any other notice: it is the one failure the
        // user cannot diagnose alone. The usual cause is a deployment URL that
        // is not registered as a redirect URI in the Spotify app. A login that
        // failed for want of network is not that, and says so.
        if (loginErrorRef.current === 'network') {
          setNotice('could not reach Spotify to finish signing in — try again once you have signal')
        } else if (loginErrorRef.current) {
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
      queuedRefs.current = []
      handedOver.current = new Set()
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

  /* --- what we know, and how sure we are -------------------------------- */

  const canQueue = !!(provider && provider.caps.has(CAPS.QUEUE))
  const station = stationRef.current

  const setLink = useCallback((next) => {
    if (linkRef.current === next) return
    linkRef.current = next
    setLinkState(next)
  }, [])

  /**
   * Record the outcome of one poll and keep the link state in step.
   * @returns {boolean} true when this answer ended an outage
   */
  const noteOutcome = useCallback(
    (stale) => {
      if (stale) {
        failStreak.current += 1
        setLink(
          browserOffline() || failStreak.current >= OFFLINE_AFTER
            ? 'offline'
            : failStreak.current >= DEGRADED_AFTER
              ? 'degraded'
              : 'online'
        )
        return false
      }
      const recovered = failStreak.current > 0
      failStreak.current = 0
      setLink('online')
      return recovered
    },
    [setLink]
  )

  /** The only writer of playback state: a stale answer never overwrites truth. */
  const applySnapshot = useCallback((raw) => {
    if (!raw) return snapRef.current
    if (!raw.stale) {
      lastGood.current = { snap: raw, at: Date.now() }
      snapRef.current = raw
      setSnapshot(raw)
      return raw
    }
    const held = holdOver(lastGood.current, raw.message || '')
    snapRef.current = held
    setSnapshot(held)
    return held
  }, [])

  /* --- the platform's queue --------------------------------------------- */

  /** Remember a user intent the network swallowed. Playback is never in here. */
  const remember = useCallback((intent) => {
    const box = outbox.current
    const i = box.findIndex((x) => x.type === intent.type)
    if (i >= 0) box.splice(i, 1) // only the latest volume / device matters
    box.push(intent)
    if (box.length > OUTBOX_MAX) box.splice(0, box.length - OUTBOX_MAX)
  }, [])

  const flushOutbox = useCallback(async () => {
    if (!provider || !outbox.current.length) return
    const pending = outbox.current
    outbox.current = []
    for (const intent of pending) {
      let r = null
      // eslint-disable-next-line no-await-in-loop
      if (intent.type === 'volume' && provider.setVolume) r = await provider.setVolume(intent.value)
      // eslint-disable-next-line no-await-in-loop
      else if (intent.type === 'transfer' && provider.selectOutput) r = await provider.selectOutput(intent.id)
      if (r && r.ok === false && r.kind === 'network') {
        remember(intent) // still nothing: keep it for the next recovery
        break
      }
    }
  }, [provider, remember])

  /**
   * How much of the walk the platform should be holding right now, in tracks —
   * derived from how long we may be unable to top it up again.
   *
   * The horizon is measured over the QUEUE ALONE, deliberately: what is playing
   * right now buys nothing, because when it ends we may be no more able to act
   * than we are now. Counting it made a nine-minute track look like ten minutes
   * of safety and left exactly one track queued behind it — after which Spotify
   * autoplays and the station is no longer ours. (Caught by
   * `scripts/net_tests.mjs` case 7, which is why it is written down here.)
   */
  const targetDepth = useCallback(() => {
    if (!station) return QUEUE_DEPTH.visible
    const hidden = typeof document !== 'undefined' && document.hidden
    const horizon = hidden
      ? HORIZON_MS.hidden
      : linkRef.current !== 'online'
        ? HORIZON_MS.degraded
        : 0
    if (horizon <= 0) return QUEUE_DEPTH.visible
    let covered = 0
    let n = 0
    for (const u of station.upNext(QUEUE_DEPTH.max)) {
      if (covered >= horizon) break
      covered += (u.node.duration_sec || FALLBACK_TRACK_MS / 1000) * 1000
      n += 1
    }
    return Math.max(QUEUE_DEPTH.visible + 1, Math.min(QUEUE_DEPTH.max, n))
  }, [station])

  /**
   * Replace our record of the platform's queue with what the platform says —
   * keeping only the refs we handed over ourselves, so Spotify's own autoplay
   * suggestions are never mistaken for the walk.
   */
  const reconcileQueue = useCallback(async () => {
    if (!provider || !provider.queuedRefs) return false
    // Standing down: no record to keep, and no accusations to make.
    if (!drivingRef.current) return false
    const reported = await provider.queuedRefs()
    lastAuditAt.current = Date.now()
    if (!reported) return false // could not ask; keep what we had
    const mine = handedOver.current

    /* --- is somebody else driving this account? ---------------------------
       There is no lock to take: the phone and the desktop share nothing but
       Spotify itself. But another New Release Radio leaves a signature nothing
       else does — a queue full of ARCHIVE tracks that we never handed over.
       Spotify's own autoplay suggests from the whole catalogue, of which our 873
       tracks are a rounding error; a person pressing next queues nothing at all.

       Two signals, because one is not enough to accuse:
         • foreign archive tracks sitting in the queue, and
         • tracks WE handed over that have vanished without playing — the
           signature of somebody else calling `play()`, which replaces the
           context and wipes the queue.
       Two or more foreign tracks is conclusive on its own (another radio queues
       that deep the moment its screen goes off). One is enough when ours
       disappeared at the same time. */
    const isOurs = (r) => {
      const id = provider.trackIdFromRef ? provider.trackIdFromRef(r) : null
      return !!(id && archive && archive.index.node(id))
    }
    const foreign = reported.filter((r) => !mine.has(r) && isOurs(r))
    const vanished = queuedRefs.current.filter((r) => !reported.includes(r))
    if (
      Date.now() > contendQuietUntil.current &&
      (foreign.length >= 2 || (foreign.length >= 1 && vanished.length > 0))
    ) {
      // Stand down first, ask second: two radios fighting over one account is
      // worse than one radio waiting. Nothing is sent from here on until the
      // user says who is in charge.
      drivingRef.current = false
      setDriving(false)
      setContended(true)
    }

    queuedRefs.current = reported.filter((r) => mine.has(r))
    return true
  }, [provider, archive])

  /**
   * Keep the platform's queue filled to the current depth. Each track is handed
   * over once; `queuedRefs` is our record of what the platform already holds,
   * in the order it will play.
   */
  const topUpQueue = useCallback(async () => {
    if (!canQueue || !provider || !station) return
    if (!drivingRef.current) return // another instance is driving: send nothing
    const depth = targetDepth()
    // Our record can be wrong in both directions after an outage. Re-check it
    // against the platform — but only when the link is worth spending on.
    if (
      linkRef.current === 'online' &&
      (Date.now() - lastAuditAt.current > QUEUE_AUDIT_MS || queuedRefs.current.length < depth)
    ) {
      await reconcileQueue()
    }
    for (const upcoming of station.upNext(depth)) {
      if (queuedRefs.current.length >= depth) break
      // eslint-disable-next-line no-await-in-loop
      const ref = await provider.resolve(upcoming.node)
      if (!ref || queuedRefs.current.includes(ref)) continue
      // eslint-disable-next-line no-await-in-loop
      const r = await provider.enqueue(upcoming.node)
      if (!r || r.ok) {
        queuedRefs.current.push(ref)
        handedOver.current.add(ref)
      } else {
        // No point piling up commands the platform is refusing — and no point
        // remembering them either: the next tick re-derives what is needed from
        // the walk, which is always more current than a stored intent.
        break
      }
    }
  }, [canQueue, provider, station, targetDepth, reconcileQueue])

  const startCurrent = useCallback(async () => {
    if (!provider || !station || !station.current) return
    pausedByUs.current = false
    // Anything that starts playback is a decision, and a decision settles the
    // question of who is driving.
    drivingRef.current = true
    setDriving(true)
    setContended(false)
    const ref = await provider.resolve(station.current)
    expectedRef.current = ref
    // `play(uri)` replaces the platform's context: whatever we had queued is gone.
    queuedRefs.current = []
    handedOver.current = new Set()
    const r = await provider.start(station.current)
    if (r && r.ok === false && r.kind === 'network') {
      flash(r.message)
      rerender()
      return
    }
    await topUpQueue()
    rerender()
  }, [provider, station, topUpQueue, rerender, flash])

  // advance the walk without touching the platform (it already moved on)
  const commitTo = useCallback(
    (node, ref) => {
      expectedRef.current = ref
      // everything up to and including `ref` has left the platform's queue
      const i = queuedRefs.current.indexOf(ref)
      queuedRefs.current = i >= 0 ? queuedRefs.current.slice(i + 1) : []
      handedOver.current.delete(ref)
      // A track boundary is the moment our record of the platform's queue is
      // most likely to be fiction, and the cheapest moment to check it: one
      // request per track instead of one per poll. On a 20-second timer alone
      // the record could claim to hold a track the platform had already lost —
      // and since it never LOOKED short, no top-up was sent either.
      lastAuditAt.current = 0
      // Keep the record of what we gave the platform from growing for ever.
      if (handedOver.current.size > 64) handedOver.current = new Set(queuedRefs.current)
      setCover(null)
      rerender()
    },
    [rerender]
  )

  /* --- join a Spotify session that is already running -------------------- */

  // Depends on `link`: if the first attempt could not reach Spotify, this runs
  // again when the network comes back instead of spending its one chance. A
  // cold start in a lift used to lose the join, so the first play restarted
  // whatever was already on air.
  useEffect(() => {
    if (phase !== 'ready' || !provider || !station || !archive || adoptedRef.current) return
    if (!canQueue || !provider.status().authenticated) return
    let alive = true
    let retry = null
    ;(async () => {
      const snap = await provider.poll()
      if (!alive) return
      noteOutcome(!!(snap && snap.stale))
      if (snap && snap.stale) {
        // No answer. This is the one chance to join a session instead of
        // restarting it, so it is worth asking again: a cold start in a lift
        // used to lose the join for the whole session.
        if (adoptAttempt < 5) retry = setTimeout(() => setAdoptAttempt((n) => n + 1), 5000)
        return
      }
      adoptedRef.current = true
      applySnapshot(snap)
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
      if (snap.artwork) setCover(snap.artwork)
      const id = provider.trackIdFromRef ? provider.trackIdFromRef(snap.ref) : null
      const node = id ? archive.index.node(id) : null
      if (node) {
        if (!station.current || station.current.id !== node.id) station.jumpTo(node.id, 'device')
        flash(`picked up your Spotify session — walking on from “${node.title}”`)
      } else {
        flash('Spotify is playing something outside the archive — press ▶ to start the walk')
      }
      if (snap.playing) setWantsPlay(true) // the loop takes it from here
      rerender()
    })()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
    }
  }, [
    phase,
    provider,
    station,
    archive,
    canQueue,
    link,
    adoptAttempt,
    startCurrent,
    applySnapshot,
    noteOutcome,
    rerender,
    flash,
  ])

  /* --- the loop --------------------------------------------------------- */

  useEffect(() => {
    if (phase !== 'ready' || !provider || !station || !wantsPlay) return
    let alive = true
    let handle = null

    const intervalFor = () => {
      if (!canQueue) return POLL_MS.local
      if (linkRef.current === 'offline') return POLL_MS.offline
      if (linkRef.current === 'degraded') return POLL_MS.degraded
      return POLL_MS.queue
    }

    const tick = async () => {
      if (!alive) return
      // One tick at a time — unless the one in flight has outlived every budget
      // it could have had, in which case it is abandoned rather than allowed to
      // hold the radio.
      if (busyRef.current && Date.now() - busySince.current < WATCHDOG_MS) return
      busyRef.current = true
      busySince.current = Date.now()
      try {
        const raw = await provider.poll()
        if (!alive) return
        const recovered = noteOutcome(!!(raw && raw.stale))
        const snap = applySnapshot(raw)
        if (snap.volume != null && Date.now() - volumeTouchedAt.current > VOLUME_HOLD_MS) {
          setVolumeState(snap.volume)
        }
        if (raw && raw.artwork) setCover(raw.artwork)

        if (raw && raw.stale) {
          // Nothing new is known, and nothing is worth sending: the connection
          // that just swallowed a read will swallow a queue command too, and
          // spending its budget here delayed noticing the recovery by tens of
          // seconds (net_tests case 4). What protects the queue is depth taken
          // BEFORE the gap — targetDepth widens the moment the link degrades —
          // and a top-up the instant an answer comes back, below.
          return
        }

        // Repeat or shuffle is fatal to a walk, and neither is ours: they live
        // on the user's player and survive between sessions. With repeat on, the
        // one-track context the station started from replays the moment the
        // queue runs out — a station that loops its own first track.
        if (
          canQueue &&
          provider.enforceModes &&
          ((snap.repeat && snap.repeat !== 'off') || snap.shuffle === true)
        ) {
          const r = await provider.enforceModes()
          // A device that refuses is the user's to fix, from the Spotify app.
          if (r && r.ok === false && r.kind !== 'network') flash(r.message, 12000)
        }

        if (recovered) {
          await flushOutbox()
          await reconcileQueue()
          await topUpQueue() // first thing after an outage: refill the platform
        }

        if (snap.playing) {
          hasPlayed.current = true
          pausedByUs.current = false // it is playing, whoever asked for it
        }

        if (canQueue) {
          const ref = snap.ref

          // **The stream ran out.** Everything we handed over has played and the
          // platform has nothing left, so it stopped — and because the station
          // starts a ONE-TRACK context, a player that falls back to its context
          // lands on the first track of the session. That is what "it stopped
          // and went back to the first track" looks like from the outside.
          //
          // This has to be decided BEFORE the ref-change branch below, or the
          // walk follows the platform onto that old track and re-anchors there:
          // the station would silently start over.
          //
          // A stop at position ~0 with an empty platform queue is running out; a
          // stop anywhere else is somebody pressing pause, and pause is sacred.
          if (
            !snap.playing &&
            drivingRef.current &&
            hasPlayed.current &&
            !pausedByUs.current &&
            (snap.position || 0) < RAN_OUT_POSITION_MS &&
            Date.now() - lastRecoveryAt.current > RECOVERY_COOLDOWN_MS &&
            provider.queuedRefs
          ) {
            const behind = queuedRefs.current.length
            const asked = await reconcileQueue()
            if (asked && queuedRefs.current.length === 0) {
              // Those `behind` tracks played while we were not watching, plus the
              // one that just finished: the walk is that far back.
              for (let i = 0; i <= behind; i++) station.advance()
              lastRecoveryAt.current = Date.now()
              flash('the stream ran out — picking the walk back up')
              await startCurrent()
              return
            }
          }

          if (ref && ref !== expectedRef.current) {
            // Which of our decided tracks is this? Coming back from a locked
            // screen or an outage it can be several steps ahead, so look along
            // the whole window and commit every step up to it — dropping them
            // on the floor would lose the history and the no-repeat memory.
            const ahead = station.upNext(RECONCILE_WINDOW)
            let hit = -1
            for (let i = 0; i < ahead.length; i++) {
              // eslint-disable-next-line no-await-in-loop
              if ((await provider.resolve(ahead[i].node)) === ref) {
                hit = i
                break
              }
            }
            if (hit >= 0) {
              for (let k = 0; k <= hit; k++) station.advance()
              commitTo(ahead[hit].node, ref)
            } else {
              // something else is on air: follow it if we know the track
              const id = provider.trackIdFromRef ? provider.trackIdFromRef(ref) : null
              const node = id && archive ? archive.index.node(id) : null
              if (node) {
                station.jumpTo(node.id, 'device')
                commitTo(node, ref)
                flash(`Spotify moved on by itself — the walk picked it up from “${node.title}”`)
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

    // A self-scheduling timeout rather than an interval: the gap is decided
    // after each tick, from the state of the link, and a slow tick can never
    // overlap the next one.
    const loop = async () => {
      await tick()
      if (alive) handle = setTimeout(loop, intervalFor())
    }

    tickRef.current = tick
    loop()
    return () => {
      alive = false
      if (handle) clearTimeout(handle)
      if (tickRef.current === tick) tickRef.current = null
    }
  }, [
    phase,
    provider,
    station,
    wantsPlay,
    canQueue,
    archive,
    commitTo,
    startCurrent,
    topUpQueue,
    reconcileQueue,
    flushOutbox,
    applySnapshot,
    noteOutcome,
    flash,
  ])

  /* --- leaving, returning, and losing the network ------------------------ */

  // The one moment that decides whether a phone in a pocket keeps playing OUR
  // radio: fill the platform's queue on the way out, and re-sync the instant we
  // are back, without waiting for the next interval.
  useEffect(() => {
    if (phase !== 'ready' || !canQueue || !wantsPlay) return
    const onVisibility = () => {
      if (document.hidden) topUpQueue()
      else if (tickRef.current) tickRef.current()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [phase, canQueue, wantsPlay, topUpQueue])

  // The browser knows about the network before we do. `online` is only a hint —
  // it means "there is an interface", not "Spotify answers" — so it downgrades
  // to `degraded` and lets the next poll prove it.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline = () => {
      failStreak.current = 0
      setLink('degraded')
      if (tickRef.current) tickRef.current()
      flushOutbox()
    }
    const onOffline = () => setLink('offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [setLink, flushOutbox])

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

  /**
   * Play. Never from a state we know to be stale: a `play` sent on a guess
   * restarts a track that never stopped, which is exactly what the amber
   * "Failed to fetch" screen invited the user to do.
   */
  const play = useCallback(async () => {
    setWantsPlay(true)
    if (!provider || !station) return
    let snap = snapRef.current
    if (snap && snap.stale && tickRef.current) {
      await tickRef.current() // ask once, now
      snap = snapRef.current
    }
    if (snap && snap.stale) {
      flash('no answer from Spotify yet — the radio will pick up as soon as the network is back')
      return
    }
    pausedByUs.current = false
    const onAir = !!(snap && snap.ref && snap.ref === expectedRef.current)
    if (onAir && snap.playing) return // already playing: nothing to restart
    if (onAir) await provider.resume()
    else await startCurrent()
  }, [provider, station, startCurrent, flash])

  const pause = useCallback(async () => {
    pausedByUs.current = true
    if (provider) await provider.pause()
    const next = { ...snapRef.current, playing: false }
    snapRef.current = next
    if (lastGood.current) lastGood.current = { snap: next, at: Date.now() }
    setSnapshot(next)
  }, [provider])

  const toggle = useCallback(() => {
    if (snapRef.current.playing) pause()
    else play()
  }, [pause, play])

  /** Next track. On a queue platform the queued track is already there. */
  const next = useCallback(async () => {
    if (!provider || !station) return
    setWantsPlay(true)
    if (canQueue && provider.skip) {
      const r = await provider.skip()
      if (!r || r.ok !== false) {
        station.noteSkip(false) // the platform will play what we queued
        // the poll will see the new track and commit the step
        rerender()
        return
      }
      // A skip that never arrived says nothing about what is playing. Falling
      // through here would send a `play` and restart the current track.
      if (r.kind === 'network') {
        flash('could not reach Spotify to skip — try again in a moment')
        return
      }
    }
    station.skip()
    await startCurrent()
  }, [provider, station, canQueue, startCurrent, rerender, flash])

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

  /** Volume: instant on the slider, debounced on the wire, honest on refusal. */
  const setVolume = useCallback(
    (percent) => {
      const v = Math.max(0, Math.min(100, Math.round(percent)))
      setVolumeState(v)
      volumeTouchedAt.current = Date.now()
      if (!provider || !provider.caps.has(CAPS.VOLUME) || !provider.setVolume) return
      if (volumeTimer.current) clearTimeout(volumeTimer.current)
      volumeTimer.current = setTimeout(async () => {
        volumeTimer.current = null
        const r = await provider.setVolume(v)
        if (!r || r.ok !== false) return
        // A refusal used to be invisible: the slider sprang back to the old
        // value at the next poll and the reason lived in a `title` tooltip that
        // a phone never shows. Now it says so, and the control steps aside —
        // but only for a real refusal. A lost request is kept and replayed.
        if (r.kind === 'network') {
          remember({ type: 'volume', value: v })
          flash('the volume will be set as soon as the network is back')
          return
        }
        const why = r.message || 'this device does not accept remote volume'
        setVolumeNote(why) // sticks: the control stays stood down
        flash(why)
      }, VOLUME_DEBOUNCE_MS)
    },
    [provider, remember, flash]
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
      const r = await provider.selectOutput(id)
      if (r && r.ok === false && r.kind === 'network') {
        remember({ type: 'transfer', id })
        flash('the stream will move to that device as soon as the network is back')
      }
      setVolumeNote('')
      await refreshOutputs()
      // Moving the stream keeps it playing: make sure the loop is watching.
      setWantsPlay(true)
    },
    [provider, refreshOutputs, remember, flash]
  )

  /** "This one is mine": resume driving, and refill what the other one left. */
  const takeOver = useCallback(async () => {
    drivingRef.current = true
    setDriving(true)
    setContended(false)
    contendQuietUntil.current = Date.now() + 60000
    handedOver.current = new Set()
    queuedRefs.current = []
    lastAuditAt.current = 0
    await topUpQueue()
    flash('this radio is driving now — the other one will notice and stand down')
  }, [topUpQueue, flash])

  /** "Let the other one play": stay on screen, send nothing, stop asking. */
  const standDown = useCallback(() => {
    drivingRef.current = false
    setDriving(false)
    setContended(false)
    flash('just listening — this radio will follow along without steering')
  }, [flash])

  const switchProvider = useCallback(
    (id) => {
      if (!id || id === providerId) return
      // Never leave two players running: silence the one we are leaving.
      if (provider && provider.pause) provider.pause()
      setProviderId(id)
      setProviderPinned(true) // an explicit choice, remembered as such
      adoptedRef.current = false // the new provider may have a live session too
      expectedRef.current = null
      queuedRefs.current = []
      handedOver.current = new Set()
      outbox.current = []
      lastGood.current = null
      failStreak.current = 0
      setLink('online')
      setOutputs([])
      setVolumeState(null)
      setVolumeNote('')
      snapRef.current = { playing: false, position: 0, duration: 0 }
      setSnapshot(snapRef.current)
    },
    [provider, providerId, setLink]
  )

  const status = provider ? provider.status() : { available: false, authenticated: false, message: '' }

  // Is there a full-track player waiting behind a login?
  const canConnect = !!(providers || []).some(
    (p) => p.caps.has(CAPS.FULL) && p.authenticate && !p.status().authenticated
  )

  // Why the volume is dead, said out loud when the user reaches for it — the
  // only channel that works on a touch screen, where there is no tooltip.
  const explainVolume = useCallback(() => {
    const out = provider && provider.currentOutput ? provider.currentOutput() : null
    const isPhone = out && (out.type === 'Smartphone' || out.type === 'Tablet')
    const why =
      volumeNote ||
      (isPhone
        ? `${out.name} sets its own volume — use the buttons on the device`
        : canConnect
          ? 'the Spotify preview player has no volume control — connect Spotify (top right) for full tracks, volume and device choice'
          : 'this player has no volume control')
    flash(why)
  }, [canConnect, volumeNote, provider, flash])

  // Logged in but listening to previews: say it once, quietly, instead of
  // silently serving 30-second clips to someone with a Premium session.
  const hint =
    !canQueue && isLoggedIn() && provider && provider.id !== 'spotify-connect'
      ? 'Spotify is connected — switch the player to Connect for full tracks'
      : ''

  // A dropped connection does not get the amber line: it is a state of the
  // link, shown on the device pill, and it says so in words only when the user
  // reaches for a control that cannot work right now.
  const ambient = status.messageKind === 'network' ? '' : status.message

  return {
    phase,
    error,
    archive,
    notice: notice || ambient || hint,

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

    // Another instance of the radio is driving this same Spotify account. There
    // is no lock to take — the two devices share nothing but Spotify — so this
    // is detected, not enforced, and the user decides.
    contended,
    driving,
    takeOver,
    standDown,

    // what we currently believe about the connection: 'online' | 'degraded' |
    // 'offline'. The UI shows it as a state of the device pill, not as an
    // error — a dropped request is not a failure of the radio.
    link,
    stale: !!snapshot.stale,

    // the platform's own playback modes, which a walk needs off
    repeat: snapshot.repeat || null,
    shuffle: snapshot.shuffle === true,

    // volume
    volume,
    canSetVolume:
      !!(provider && provider.caps.has(CAPS.VOLUME)) &&
      snapshot.volumeAvailable !== false &&
      !volumeNote,
    volumeNote,
    setVolume,

    // outputs
    outputs,
    currentOutput: provider && provider.currentOutput ? provider.currentOutput() : null,
    // A handset sets its own volume: Spotify refuses the remote command, and the
    // hardware buttons are the real control. The UI uses this to decide whether
    // a volume slider is worth offering on a touch screen at all.
    outputIsHandset: (() => {
      const o = provider && provider.currentOutput ? provider.currentOutput() : null
      return !!(o && (o.type === 'Smartphone' || o.type === 'Tablet'))
    })(),
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
