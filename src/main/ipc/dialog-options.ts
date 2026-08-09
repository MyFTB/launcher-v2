import type { OpenDialogOptions } from 'electron'

export function getStorageDirectoryDialogOptions(defaultPath: string): OpenDialogOptions {
  return {
    title: 'Bitte wähle den Speicherort für installierte Modpacks',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  }
}

export function getDataDirectoryDialogOptions(defaultPath: string): OpenDialogOptions {
  return {
    title: 'Neuen Speicherort für Launcher-Daten wählen',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  }
}

export function getRecoveryDirectoryDialogOptions(defaultPath: string): OpenDialogOptions {
  return {
    title: 'Vorhandenen MyFTB-Datenordner auswählen',
    defaultPath,
    properties: ['openDirectory'],
  }
}
