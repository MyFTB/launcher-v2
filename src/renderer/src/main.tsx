import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import ConsoleStandalone from './ConsoleStandalone'
import './index.css'

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
