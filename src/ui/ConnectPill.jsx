import React from 'react'

/* The single call to action on the main screen.

   Without it, someone with a Premium account had no way out of preview mode
   without discovering the panel: the preview provider has no login of its own,
   so the pill asks the registry for the player that can do full tracks. */

const Glyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.8.8 0 0 1-1.1.3c-3-1.9-6.8-2.3-11.2-1.3a.8.8 0 1 1-.4-1.6c4.8-1.1 9-.6 12.4 1.5.4.2.5.7.3 1.1zm1.2-2.9a1 1 0 0 1-1.4.3c-3.4-2.1-8.6-2.7-12.6-1.5a1 1 0 1 1-.6-1.9c4.6-1.4 10.3-.7 14.2 1.7.5.3.6.9.4 1.4zm.1-3a1.2 1.2 0 0 1-1.6.4C12.4 8.5 6.4 8.3 3 9.4a1.2 1.2 0 1 1-.7-2.3c4-1.2 10.6-1 14.7 1.4.6.3.8 1.1.4 1.7z" />
  </svg>
)

export default function ConnectPill({ onConnect }) {
  return (
    <button
      className="chip connect"
      onClick={onConnect}
      title="Play whole tracks on your own Spotify device, choose the device and control the volume — needs Premium. The login stays in your browser."
    >
      <Glyph />
      <span>connect Spotify</span>
    </button>
  )
}
