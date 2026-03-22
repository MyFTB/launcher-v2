import { NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { getStoredNewPacks } from '../utils/packBadge'
import logoUrl from '../assets/logo.svg'

/** Icons as SVG strings — replace with lucide-react or heroicons once added */
const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 flex-shrink-0">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
)

const NewsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 flex-shrink-0">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9" />
  </svg>
)

const GridIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 flex-shrink-0">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
  </svg>
)

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 flex-shrink-0">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
  </svg>
)

const GearIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 flex-shrink-0">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
)

const navItems = [
  { to: '/home', label: 'Startseite', Icon: HomeIcon },
  { to: '/news', label: 'Neuigkeiten', Icon: NewsIcon },
  { to: '/available', label: 'Verfügbar', Icon: GridIcon },
  { to: '/installed', label: 'Installiert', Icon: CheckIcon },
]

export default function Sidebar() {
  const [newPacksCount, setNewPacksCount] = useState(() => getStoredNewPacks().size)

  useEffect(() => {
    const handler = (e: Event): void => {
      setNewPacksCount((e as CustomEvent<{ count: number }>).detail.count)
    }
    window.addEventListener('myftb:newpacks', handler)
    return () => window.removeEventListener('myftb:newpacks', handler)
  }, [])
  return (
    <nav className="flex flex-col w-14 hover:w-52 transition-all duration-200 bg-bg-surface border-r border-border flex-shrink-0 overflow-hidden group">
      {/* Logo */}
      <div className="flex items-center py-4 border-b border-border">
        <div className="w-14 flex justify-center flex-shrink-0">
          <img src={logoUrl} alt="MyFTB" className="w-8 h-8" draggable={false} />
        </div>
        <span className="text-sm font-bold text-text-primary opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out whitespace-nowrap">
          MyFTB
        </span>
      </div>

      {/* Nav links */}
      <div className="flex flex-col flex-1 py-2">
        {navItems.map(({ to, label, Icon }) => {
          const badge = to === '/available' ? newPacksCount : 0
          return (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center py-3 text-sm transition-[background-color,color,transform] duration-150 no-drag ${
                isActive
                  ? 'text-accent bg-accent/10 border-r-2 border-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated active:scale-[0.98]'
              }`
            }
          >
            <span className="w-14 flex justify-center flex-shrink-0 relative">
              <Icon />
              {badge > 0 && (
                <span className="absolute top-0 right-2 w-2 h-2 rounded-full bg-accent group-hover:hidden" />
              )}
            </span>
            <span className="flex-1 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap pr-4">
              {label}
              {badge > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-xs font-bold bg-accent text-black leading-none">
                  {badge}
                </span>
              )}
            </span>
          </NavLink>
          )
        })}
      </div>

      {/* Settings at bottom */}
      <div className="border-t border-border">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center py-3 text-sm transition-[background-color,color,transform] duration-150 no-drag ${
              isActive
                ? 'text-accent bg-accent/10 border-r-2 border-accent'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated active:scale-[0.98]'
            }`
          }
        >
          <span className="w-14 flex justify-center flex-shrink-0">
            <GearIcon />
          </span>
          <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap pr-4">
            Einstellungen
          </span>
        </NavLink>
      </div>
    </nav>
  )
}
