import { useState } from 'react'
import type { Feature } from '@shared/types'

interface FeatureModalProps {
  features: Feature[]
  onConfirm: (selectedNames: string[]) => void
  onCancel: () => void
}

export default function FeatureModal({ features, onConfirm, onCancel }: FeatureModalProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(features.filter((f) => f.default).map((f) => f.name))
  )

  function toggleFeature(name: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="card w-full max-w-md mx-4 p-6 animate-slide-up shadow-2xl">
        <h2 className="text-lg font-semibold text-text-primary mb-1">Optionale Features</h2>
        <p className="text-sm text-text-secondary mb-5">
          Wähle die Features, die du installieren möchtest.
        </p>

        <div className="space-y-3 mb-6">
          {features.map((feature) => (
            <label
              key={feature.name}
              className="flex items-start gap-3 cursor-pointer group"
            >
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4 rounded border-border bg-bg-elevated accent-accent cursor-pointer flex-shrink-0"
                checked={selected.has(feature.name)}
                onChange={() => toggleFeature(feature.name)}
              />
              <div>
                <span className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                  {feature.name}
                </span>
                {feature.description && (
                  <p className="text-xs text-text-muted mt-0.5">{feature.description}</p>
                )}
              </div>
            </label>
          ))}
        </div>

        <div className="flex gap-3 justify-end">
          <button className="btn-secondary" onClick={onCancel}>
            Abbrechen
          </button>
          <button
            className="btn-primary"
            onClick={() => onConfirm(Array.from(selected))}
          >
            Installieren
          </button>
        </div>
      </div>
    </div>
  )
}
