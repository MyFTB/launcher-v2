import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import UpdateBanner from './components/UpdateBanner'
import Home from './pages/Home'
import AvailablePacks from './pages/AvailablePacks'
import InstalledPacks from './pages/InstalledPacks'
import Settings from './pages/Settings'
import Console from './pages/Console'
import News from './pages/News'
import {
  getKnownPacks,
  getStoredNewPacks,
  saveStoredNewPacks,
  dispatchNewPackCount,
} from './utils/packBadge'

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function DetachIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  )
}

const MIN_DRAWER_HEIGHT = 120
const MAX_DRAWER_RATIO = 0.85

export default function App() {
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState(300)
  const drawerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startH: number; currentH: number } | null>(null)

  useEffect(() => {
    window.electronAPI.configGet().catch(console.error)
  }, [])

  // Background pack check on startup so Sidebar badge shows before visiting Available Packs
  useEffect(() => {
    window.electronAPI.packsGetRemote()
      .then((remote) => {
        const remoteNames = remote.map((p) => p.name)
        const remoteSet = new Set(remoteNames)
        const known = getKnownPacks()
        if (known.size === 0) return // first run, skip — AvailablePacks will seed on first visit
        const stored = getStoredNewPacks()
        for (const n of remoteNames) { if (!known.has(n)) stored.add(n) }
        const pruned = new Set([...stored].filter((n) => remoteSet.has(n)))
        if (pruned.size > 0) {
          saveStoredNewPacks(Array.from(pruned))
          dispatchNewPackCount(pruned.size)
        }
      })
      .catch(() => {})
  }, [])

  // Allow other components to open the console via custom event
  useEffect(() => {
    const handler = (): void => setConsoleOpen(true)
    window.addEventListener('open-console', handler)
    return () => window.removeEventListener('open-console', handler)
  }, [])

  // Resize drag logic — DOM-direct during drag, state sync on mouse-up
  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current || !drawerRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const max = window.innerHeight * MAX_DRAWER_RATIO
      const newH = Math.max(MIN_DRAWER_HEIGHT, Math.min(max, dragRef.current.startH + delta))
      dragRef.current.currentH = newH
      drawerRef.current.style.height = `${newH}px`
    }
    const onMouseUp = (): void => {
      if (dragRef.current) {
        setDrawerHeight(Math.round(dragRef.current.currentH))
        if (drawerRef.current) drawerRef.current.style.transition = ''
      }
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  function handleDetach(): void {
    window.electronAPI.windowOpenConsole().catch(console.error)
    setConsoleOpen(false)
  }

  return (
    <div className="flex flex-col h-full bg-bg-base text-text-primary overflow-hidden">
      <TitleBar />
      <UpdateBanner />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

        <main className="relative flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<Home />} />
              <Route path="/news" element={<News />} />
              <Route path="/available" element={<AvailablePacks />} />
              <Route path="/installed" element={<InstalledPacks />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </div>

          {/* Console drawer */}
          <div
            ref={drawerRef}
            className="absolute inset-x-0 bottom-0 flex flex-col bg-bg-surface border-t border-border shadow-2xl overflow-hidden"
            style={{
              height: consoleOpen ? drawerHeight : 0,
              transition: 'height 300ms ease-in-out',
            }}
          >
            {/* Resize handle */}
            <div
              className="flex items-center justify-between px-3 h-6 bg-bg-elevated border-b border-border flex-shrink-0 cursor-ns-resize select-none group"
              onMouseDown={(e) => {
                if (!drawerRef.current) return
                drawerRef.current.style.transition = 'none'
                dragRef.current = { startY: e.clientY, startH: drawerHeight, currentH: drawerHeight }
                e.preventDefault()
              }}
            >
              {/* Drag grip indicator */}
              <div className="flex gap-0.5 opacity-40 group-hover:opacity-70 transition-opacity">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="w-4 h-px bg-text-muted" />
                ))}
              </div>

              <div className="flex items-center gap-1">
                {/* Detach button */}
                <button
                  className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay transition-colors"
                  title="In eigenem Fenster öffnen"
                  onClick={handleDetach}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <DetachIcon />
                </button>
                {/* Close button */}
                <button
                  className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay transition-colors"
                  title="Schließen"
                  onClick={() => setConsoleOpen(false)}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <ChevronDownIcon />
                </button>
              </div>
            </div>

            {consoleOpen && <Console />}
          </div>

          {/* Floating console toggle button */}
          <button
            onClick={() => setConsoleOpen((o) => !o)}
            className={`absolute bottom-4 right-4 w-11 h-11 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 no-drag z-10 ${
              consoleOpen
                ? 'bg-accent text-bg-base hover:bg-accent-dim'
                : 'bg-bg-overlay text-text-secondary hover:bg-bg-elevated hover:text-text-primary border border-border'
            }`}
            title={consoleOpen ? 'Konsole schließen' : 'Konsole öffnen'}
          >
            {consoleOpen ? <ChevronDownIcon /> : <TerminalIcon />}
          </button>
        </main>
      </div>
    </div>
  )
}
