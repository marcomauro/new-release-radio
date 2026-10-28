/* ----------------------------------------------------------------------------
   yt_stub.mjs — a stand-in for YouTube's IFrame Player API, for the Playwright
   suites (net_tests.mjs, fit_tests.mjs).

   The real API is a script from youtube.com that builds an iframe and talks to
   it by postMessage; neither is something a test should depend on. The stub
   replaces the script at the network boundary and keeps real state: the video
   loaded, a clock, the end of a video, embeds an owner refused, a browser that
   blocks playback a tap on the video did not start. Every call the app makes
   is logged in `window.__ytStub.calls`, which is what the assertions read.

   Configure it before the page loads, with `window.__ytConfig`:
     { durationSec, refuse: { videoId: errorCode }, blockAutoplay, startDelayMs }
   and `window.__ytStub.tap()` is a tap on the video itself.
   -------------------------------------------------------------------------- */

export const YT_API_SCRIPT = `
(function () {
  var cfg = window.__ytConfig || {}
  var S = (window.__ytStub = {
    calls: [],
    loaded: [],
    players: [],
    durationSec: cfg.durationSec || 4,
    refuse: cfg.refuse || {},
    blockAutoplay: !!cfg.blockAutoplay,
    startDelayMs: cfg.startDelayMs || 0,
    tapped: false,
    tap: function () {
      S.tapped = true
      S.players.forEach(function (p) { if (p._vid) p._play() })
    },
  })
  function Player(el, opts) {
    var f = document.createElement('iframe')
    f.className = 'yt-fake'
    f.setAttribute('data-host', opts.host || '')
    el.replaceWith(f)
    this._f = f
    this._ev = opts.events || {}
    this._state = -1
    this._vid = null
    this._pos = 0
    this._t0 = 0
    this._vol = 100
    this._timer = null
    S.players.push(this)
    var self = this
    setTimeout(function () { self._ev.onReady && self._ev.onReady({ target: self }) }, 50)
  }
  Player.prototype._emit = function (s) {
    this._state = s
    this._ev.onStateChange && this._ev.onStateChange({ data: s, target: this })
  }
  Player.prototype._stop = function () { clearInterval(this._timer); this._timer = null }
  Player.prototype._play = function () {
    var self = this
    this._stop()
    this._t0 = Date.now() - this._pos * 1000
    this._emit(1)
    this._timer = setInterval(function () {
      if (self.getCurrentTime() >= S.durationSec) {
        self._stop()
        self._pos = S.durationSec
        self._emit(0)
      }
    }, 100)
  }
  Player.prototype.loadVideoById = function (id) {
    S.calls.push('load ' + id)
    S.loaded.push(id)
    this._stop()
    this._vid = id
    this._pos = 0
    var self = this
    if (S.refuse[id]) {
      this._emit(-1)
      setTimeout(function () { self._ev.onError && self._ev.onError({ data: S.refuse[id], target: self }) }, 80)
      return
    }
    if (S.blockAutoplay && !S.tapped) { this._emit(-1); return }
    if (S.startDelayMs) {
      // YouTube taking its time: "unstarted", then playing, with no help.
      this._emit(-1)
      this._wait = setTimeout(function () { if (self._vid === id) self._play() }, S.startDelayMs)
      return
    }
    this._play()
  }
  Player.prototype.playVideo = function () {
    S.calls.push('play')
    if (!this._vid || (S.blockAutoplay && !S.tapped)) return
    this._play()
  }
  Player.prototype.pauseVideo = function () {
    S.calls.push('pause')
    if (this._state !== 1) return
    this._pos = this.getCurrentTime()
    this._stop()
    this._emit(2)
  }
  Player.prototype.seekTo = function (s) {
    S.calls.push('seek ' + Math.round(s))
    this._pos = s
    if (this._state === 1) this._t0 = Date.now() - s * 1000
  }
  Player.prototype.getCurrentTime = function () {
    return this._state === 1 ? (Date.now() - this._t0) / 1000 : this._pos
  }
  Player.prototype.getDuration = function () { return this._vid ? S.durationSec : 0 }
  Player.prototype.getPlayerState = function () { return this._state }
  Player.prototype.setVolume = function (v) { S.calls.push('volume ' + v); this._vol = v }
  Player.prototype.getVolume = function () { return this._vol }
  Player.prototype.isMuted = function () { return false }
  Player.prototype.unMute = function () {}
  Player.prototype.destroy = function () {
    S.calls.push('destroy')
    this._stop()
    this._f.remove()
  }
  window.YT = { Player: Player, PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } }
  setTimeout(function () { window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady() }, 0)
})()
`

/** Serve the stub in place of youtube.com's script; nothing else from YouTube loads. */
export async function routeYouTube(page, config = {}) {
  await page.addInitScript(`window.__ytConfig = ${JSON.stringify(config)}`)
  await page.route('**://www.youtube.com/iframe_api', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: YT_API_SCRIPT })
  )
}
