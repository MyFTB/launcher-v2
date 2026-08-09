export interface WindowFrameOptions {
  frame: boolean
  roundedCorners?: boolean
}

/** Preserve the launcher's existing frame behavior on each desktop platform. */
export function getWindowFrameOptions(platform: NodeJS.Platform): WindowFrameOptions {
  if (platform === 'darwin') return { frame: true }
  if (platform === 'linux') return { frame: false, roundedCorners: false }
  return { frame: false }
}
