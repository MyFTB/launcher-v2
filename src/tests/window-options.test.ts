import { describe, expect, it } from 'vitest'

import { getWindowFrameOptions } from '../main/window-options'

describe('platform window frame options', () => {
  it('keeps macOS windows framed', () => {
    expect(getWindowFrameOptions('darwin')).toEqual({ frame: true })
  })

  it('keeps Windows frameless without changing its corner behavior', () => {
    expect(getWindowFrameOptions('win32')).toEqual({ frame: false })
  })

  it('keeps Linux frameless windows square on Electron 43', () => {
    expect(getWindowFrameOptions('linux')).toEqual({
      frame: false,
      roundedCorners: false,
    })
  })
})
