import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import type { LaunchState } from '@shared/types'
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
  const [isDragging, setIsDragging] = useState(false)
  const [isGameActive, setIsGameActive] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

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

  // Track running game for FAB indicator
  useEffect(() => {
    const unsub = window.electronAPI.on('launch:state', (...args: unknown[]) => {
      const event = args[0] as { state: LaunchState }
      setIsGameActive(event.state === 'launching' || event.state === 'running')
    })
    return unsub
  }, [])

  // Resize drag logic — state-driven so React re-renders never snap back to stale height
  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const max = window.innerHeight * MAX_DRAWER_RATIO
      const newH = Math.round(Math.max(MIN_DRAWER_HEIGHT, Math.min(max, dragRef.current.startH + delta)))
      setDrawerHeight(newH)
    }
    const onMouseUp = (): void => {
      dragRef.current = null
      setIsDragging(false)
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
              transition: isDragging ? 'none' : 'height 300ms ease-in-out',
            }}
          >
            {/* Resize handle */}
            <div
              className="flex items-center justify-end px-3 h-6 bg-bg-elevated border-b border-border flex-shrink-0 cursor-ns-resize select-none"
              onMouseDown={(e) => {
                if (!drawerRef.current) return
                dragRef.current = { startY: e.clientY, startH: drawerHeight }
                setIsDragging(true)
                e.preventDefault()
              }}
            >
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

            <Console />
          </div>

          {/* Floating console toggle button — hidden when drawer is open */}
          {!consoleOpen && (
            <button
              onClick={() => setConsoleOpen(true)}
              className={`absolute bottom-4 right-4 w-11 h-11 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 ease-out no-drag z-10 bg-bg-overlay text-text-secondary hover:bg-bg-elevated hover:text-text-primary hover:scale-105 hover:border-border-focus/40 active:scale-95 border border-border ${isGameActive ? 'hover:shadow-[0_0_20px_rgba(131,218,56,0.25)]' : ''}`}
              title="Konsole öffnen"
            >
              <TerminalIcon />
              {isGameActive && (
                <span className="absolute top-0.5 right-0.5 w-2.5 h-2.5 rounded-full bg-accent border-2 border-bg-base animate-pulse" />
              )}
            </button>
          )}
        </main>
      </div>
    </div>
  )
}
