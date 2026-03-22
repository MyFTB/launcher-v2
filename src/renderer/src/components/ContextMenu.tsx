import { useEffect, useRef } from 'react'

interface ContextMenuItem {
  label: string
  action: () => void
  danger?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  // Constrain to viewport
  const menuWidth = 200
  const menuHeight = items.length * 36 + 8
  const constrainedX = Math.min(x, window.innerWidth - menuWidth - 8)
  const constrainedY = Math.min(y, window.innerHeight - menuHeight - 8)

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] rounded-xl bg-bg-elevated border border-border shadow-2xl py-1 animate-fade-in"
      style={{ left: constrainedX, top: constrainedY, width: menuWidth }}
    >
      {items.map((item, index) => (
        <button
          key={index}
          className={`w-full text-left px-4 py-2 text-sm transition-[background-color,color,transform] duration-150 hover:bg-bg-overlay active:scale-[0.98] ${
            item.danger ? 'text-red-400 hover:text-red-300' : 'text-text-primary'
          }`}
          onClick={() => {
            item.action()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
