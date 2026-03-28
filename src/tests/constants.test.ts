import { describe, it, expect } from 'vitest'
import { Constants } from '../main/constants'

describe('Constants', () => {
  it('recentPacksMax is 3', () => {
    expect(Constants.recentPacksMax).toBe(3)
  })
})
