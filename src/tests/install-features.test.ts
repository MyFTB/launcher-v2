import { describe, it, expect } from 'vitest'
import type { Feature, FileTask, FeatureCondition } from '@shared/types'
import { evaluateCondition, inferSelectedFeatures } from '../main/services/install.service'

// ─── Helper: compute diff between old and new feature selections ─────────────

function computeFeatureDiff(
  tasks: FileTask[],
  oldSelection: string[],
  newSelection: string[],
): { toDownload: FileTask[]; toDelete: FileTask[] } {
  const toDownload: FileTask[] = []
  const toDelete: FileTask[] = []

  for (const task of tasks) {
    if (!task.when) continue
    const nowIncluded = evaluateCondition(task.when, newSelection)
    const wasIncluded = evaluateCondition(task.when, oldSelection)
    if (nowIncluded && !wasIncluded) toDownload.push(task)
    if (!nowIncluded && wasIncluded) toDelete.push(task)
  }

  return { toDownload, toDelete }
}

// ─── Test data builders ──────────────────────────────────────────────────────

function makeFeature(name: string, isDefault = false): Feature {
  return { name, description: `${name} description`, default: isDefault }
}

function makeTask(to: string, when?: FeatureCondition): FileTask {
  return {
    to,
    hash: 'abc123',
    location: `objects/abc123`,
    userFile: false,
    when,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('feature diff computation', () => {
  const optifineTask = makeTask('mods/optifine.jar', {
    if: 'requireAny',
    features: ['optifine'],
  })
  const shadersTask = makeTask('mods/shaders.jar', {
    if: 'requireAny',
    features: ['shaders'],
  })
  const comboTask = makeTask('mods/combo.jar', {
    if: 'requireAll',
    features: ['optifine', 'shaders'],
  })
  const baseTask = makeTask('mods/base.jar') // no condition

  const allTasks = [optifineTask, shadersTask, comboTask, baseTask]

  it('detects newly selected features as downloads', () => {
    const { toDownload, toDelete } = computeFeatureDiff(allTasks, [], ['optifine'])
    expect(toDownload).toEqual([optifineTask])
    expect(toDelete).toEqual([])
  })

  it('detects deselected features as deletions', () => {
    const { toDownload, toDelete } = computeFeatureDiff(allTasks, ['optifine'], [])
    expect(toDownload).toEqual([])
    expect(toDelete).toEqual([optifineTask])
  })

  it('handles swapping features', () => {
    const { toDownload, toDelete } = computeFeatureDiff(
      allTasks,
      ['optifine'],
      ['shaders'],
    )
    expect(toDownload).toEqual([shadersTask])
    expect(toDelete).toEqual([optifineTask])
  })

  it('handles requireAll: combo task added when both selected', () => {
    const { toDownload, toDelete } = computeFeatureDiff(
      allTasks,
      ['optifine'],
      ['optifine', 'shaders'],
    )
    expect(toDownload).toEqual([shadersTask, comboTask])
    expect(toDelete).toEqual([])
  })

  it('handles requireAll: combo task removed when one deselected', () => {
    const { toDownload, toDelete } = computeFeatureDiff(
      allTasks,
      ['optifine', 'shaders'],
      ['optifine'],
    )
    expect(toDownload).toEqual([])
    expect(toDelete).toEqual([shadersTask, comboTask])
  })

  it('ignores tasks without conditions', () => {
    const { toDownload, toDelete } = computeFeatureDiff(allTasks, [], ['optifine', 'shaders'])
    // baseTask should never appear in diff
    expect(toDownload).not.toContainEqual(baseTask)
    expect(toDelete).not.toContainEqual(baseTask)
  })

  it('returns empty diff when selection unchanged', () => {
    const { toDownload, toDelete } = computeFeatureDiff(
      allTasks,
      ['optifine'],
      ['optifine'],
    )
    expect(toDownload).toEqual([])
    expect(toDelete).toEqual([])
  })

  it('returns empty diff when no tasks have conditions', () => {
    const { toDownload, toDelete } = computeFeatureDiff([baseTask], ['optifine'], [])
    expect(toDownload).toEqual([])
    expect(toDelete).toEqual([])
  })

  it('handles selecting all features from none', () => {
    const { toDownload, toDelete } = computeFeatureDiff(
      allTasks,
      [],
      ['optifine', 'shaders'],
    )
    expect(toDownload).toEqual([optifineTask, shadersTask, comboTask])
    expect(toDelete).toEqual([])
  })

  it('handles deselecting all features', () => {
    const { toDownload, toDelete } = computeFeatureDiff(
      allTasks,
      ['optifine', 'shaders'],
      [],
    )
    expect(toDownload).toEqual([])
    expect(toDelete).toEqual([optifineTask, shadersTask, comboTask])
  })
})

describe('inferSelectedFeatures', () => {
  const optifine = makeFeature('optifine', true)
  const shaders = makeFeature('shaders', false)
  const minimap = makeFeature('minimap', true)

  const tasks: FileTask[] = [
    makeTask('mods/optifine.jar', { if: 'requireAny', features: ['optifine'] }),
    makeTask('mods/optifine-config.cfg', { if: 'requireAny', features: ['optifine'] }),
    makeTask('mods/shaders.jar', { if: 'requireAny', features: ['shaders'] }),
    makeTask('mods/base.jar'), // no condition
  ]

  it('infers features from existing files', () => {
    const existing = new Set(['mods/optifine.jar'])
    const result = inferSelectedFeatures([optifine, shaders], tasks, existing)
    expect(result).toContain('optifine')
    expect(result).not.toContain('shaders')
  })

  it('infers feature as selected if any gated file exists', () => {
    // Only the config file exists, not the jar — still inferred as selected
    const existing = new Set(['mods/optifine-config.cfg'])
    const result = inferSelectedFeatures([optifine, shaders], tasks, existing)
    expect(result).toContain('optifine')
  })

  it('returns empty for no existing files', () => {
    const result = inferSelectedFeatures([optifine, shaders], tasks, new Set())
    expect(result).toEqual([])
  })

  it('falls back to default when feature has no gated tasks', () => {
    // minimap has no tasks that gate on it
    const existing = new Set<string>()
    const result = inferSelectedFeatures([minimap], tasks, existing)
    expect(result).toContain('minimap')
  })

  it('does not include non-default feature with no gated tasks', () => {
    const nonDefault = makeFeature('extra', false)
    const result = inferSelectedFeatures([nonDefault], tasks, new Set())
    expect(result).not.toContain('extra')
  })

  it('handles empty features array', () => {
    const result = inferSelectedFeatures([], tasks, new Set(['mods/optifine.jar']))
    expect(result).toEqual([])
  })

  it('handles empty tasks array', () => {
    const result = inferSelectedFeatures([optifine, shaders], [], new Set())
    // No tasks → falls back to defaults
    expect(result).toContain('optifine')
    expect(result).not.toContain('shaders')
  })
})
