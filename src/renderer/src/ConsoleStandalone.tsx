import Console from './pages/Console'
import TitleBar from './components/TitleBar'

/**
 * Standalone console window — rendered when ?standalone=1 query param is present.
 * No sidebar, no routing; just the title bar and the full Console component.
 */
export default function ConsoleStandalone(): JSX.Element {
  return (
    <div className="flex flex-col h-full bg-bg-base text-text-primary overflow-hidden">
      <TitleBar title="Konsole — MyFTB Launcher" />
      <div className="flex-1 overflow-hidden">
        <Console />
      </div>
    </div>
  )
}
