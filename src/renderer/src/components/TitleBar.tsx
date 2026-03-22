/**
 * Custom frameless window title bar.
 * Provides drag region and close/minimize/maximize controls.
 */
export default function TitleBar({ title = 'MyFTB Launcher' }: { title?: string } = {}) {
  return (
    <div className="drag-region flex items-center justify-between h-8 px-3 bg-bg-base border-b border-border shrink-0 select-none">
      {/* App name */}
      <span className="text-xs text-text-muted font-medium no-drag">{title}</span>

      {/* Window controls — macOS shows native traffic lights via titleBarStyle: 'hidden' */}
      {/* On Windows/Linux we render custom buttons */}
      {process.platform !== 'darwin' && (
        <div className="flex items-center gap-1 no-drag">
          <button
            className="w-4 h-4 rounded-full bg-bg-overlay hover:bg-yellow-500 transition-colors"
            title="Minimize"
            onClick={() => window.electronAPI.windowMinimize()}
          />
          <button
            className="w-4 h-4 rounded-full bg-bg-overlay hover:bg-green-500 transition-colors"
            title="Maximize"
            onClick={() => window.electronAPI.windowMaximize()}
          />
          <button
            className="w-4 h-4 rounded-full bg-bg-overlay hover:bg-red-500 transition-colors"
            title="Close"
            onClick={() => window.electronAPI.windowClose()}
          />
        </div>
      )}
    </div>
  )
}
