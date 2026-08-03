import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { preloadEmbedApi } from './providers/spotify/embed.js'
import './index.css'

// The Spotify iframe API takes a moment to arrive: start it before the first
// press of play so the preview provider is warm.
preloadEmbedApi()

createRoot(document.getElementById('root')).render(<App />)
