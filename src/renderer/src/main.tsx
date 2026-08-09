import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import ConsoleStandalone from './ConsoleStandalone'
import { useLaunchStore } from './store/launch.store'
import { useAuthStore } from './store/auth.store'
import { useModpackStore } from './store/modpack.store'
import '@fontsource-variable/outfit'
import './index.css'

const isStandalone = new URLSearchParams(window.location.search).has('standalone')

// The detached console has a deliberately restricted preload API.
useLaunchStore.getState().initListeners()
if (!isStandalone) {
  useAuthStore.getState().initListeners()
  useModpackStore.getState().initListeners()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isStandalone ? (
      <ConsoleStandalone />
    ) : (
      <HashRouter>
        <App />
      </HashRouter>
    )}
  </React.StrictMode>
)
