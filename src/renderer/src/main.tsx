import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import ConsoleStandalone from './ConsoleStandalone'
import { useLaunchStore } from './store/launch.store'
import '@fontsource-variable/outfit'
import './index.css'

// Wire push-event listeners that drive store state.
// initListeners() is idempotent and must be called before any component mounts.
useLaunchStore.getState().initListeners()

const isStandalone = new URLSearchParams(window.location.search).has('standalone')

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
