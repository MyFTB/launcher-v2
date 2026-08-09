import { describe, expect, it } from 'vitest'

import {
  getDataDirectoryDialogOptions,
  getRecoveryDirectoryDialogOptions,
  getStorageDirectoryDialogOptions,
} from '../main/ipc/dialog-options'

describe('directory dialog options', () => {
  it('starts storage selection at the current modpack directory', () => {
    expect(getStorageDirectoryDialogOptions('/launcher/modpacks')).toEqual({
      title: 'Bitte wähle den Speicherort für installierte Modpacks',
      defaultPath: '/launcher/modpacks',
      properties: ['openDirectory', 'createDirectory'],
    })
  })

  it('starts data migration at the current launcher data directory', () => {
    expect(getDataDirectoryDialogOptions('/launcher/data')).toEqual({
      title: 'Neuen Speicherort für Launcher-Daten wählen',
      defaultPath: '/launcher/data',
      properties: ['openDirectory', 'createDirectory'],
    })
  })

  it('starts recovery at the current launcher data directory', () => {
    expect(getRecoveryDirectoryDialogOptions('/launcher/recovery')).toEqual({
      title: 'Vorhandenen MyFTB-Datenordner auswählen',
      defaultPath: '/launcher/recovery',
      properties: ['openDirectory'],
    })
  })
})
