import { describe, it, expect } from 'vitest'

// Mirror of CircularLineBuffer from launch.service.ts (not exported)
class CircularLineBuffer {
  private readonly cap: number
  private lines: string[] = []
  constructor(cap: number) {
    this.cap = cap
  }
  push(line: string): void {
    if (this.lines.length >= this.cap) this.lines.shift()
    this.lines.push(line)
  }
  getAll(): string[] {
    return this.lines.slice()
  }
  getText(): string {
    return this.lines.join('\n')
  }
  clear(): void {
    this.lines = []
  }
}

describe('CircularLineBuffer', () => {
  it('push below capacity - getAll returns all items', () => {
    const buf = new CircularLineBuffer(5)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    expect(buf.getAll()).toEqual(['a', 'b', 'c'])
  })

  it('push at capacity causes oldest to be dropped', () => {
    const buf = new CircularLineBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    expect(buf.getAll()).toEqual(['b', 'c', 'd'])
  })

  it('push well beyond capacity - only last cap items remain', () => {
    const buf = new CircularLineBuffer(3)
    for (let i = 0; i < 10; i++) buf.push(`line-${i}`)
    expect(buf.getAll()).toEqual(['line-7', 'line-8', 'line-9'])
  })

  it('getAll returns a copy - mutating it does not affect buffer', () => {
    const buf = new CircularLineBuffer(5)
    buf.push('x')
    buf.push('y')
    const copy = buf.getAll()
    copy.push('MUTATED')
    copy[0] = 'CHANGED'
    expect(buf.getAll()).toEqual(['x', 'y'])
  })

  it('getText joins with newlines', () => {
    const buf = new CircularLineBuffer(5)
    buf.push('first')
    buf.push('second')
    buf.push('third')
    expect(buf.getText()).toBe('first\nsecond\nthird')
  })

  it('getText on empty buffer returns empty string', () => {
    const buf = new CircularLineBuffer(5)
    expect(buf.getText()).toBe('')
  })

  it('clear resets to empty', () => {
    const buf = new CircularLineBuffer(5)
    buf.push('a')
    buf.push('b')
    buf.clear()
    expect(buf.getAll()).toEqual([])
    expect(buf.getText()).toBe('')
  })

  it('buffer with capacity 1 always holds only the last item', () => {
    const buf = new CircularLineBuffer(1)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    expect(buf.getAll()).toEqual(['c'])
  })
})
