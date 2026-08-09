import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'

import type {
  IpcErrorCode,
  IpcErrorDto,
  IpcResponse,
} from '../../shared/types'
import { ValidationError } from '../../shared/validation'
import { getTrustedWindow, type WindowRole } from '../app-state'
import { logger } from '../logger'

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

interface HandlerOptions<TPayload> {
  roles?: WindowRole[]
  validate?: (payload: unknown) => TPayload
}

export function isTrustedRendererUrl(value: string): boolean {
  try {
    const current = new URL(value)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) {
      const expected = new URL(developmentUrl)
      return current.origin === expected.origin && current.pathname === expected.pathname
    }
    if (current.protocol !== 'file:') return false
    current.search = ''
    current.hash = ''
    const currentPath = path.resolve(fileURLToPath(current))
    const expectedPath = path.resolve(__dirname, '../renderer/index.html')
    return process.platform === 'win32'
      ? currentPath.toLocaleLowerCase('en-US') === expectedPath.toLocaleLowerCase('en-US')
      : currentPath === expectedPath
  } catch {
    return false
  }
}

function authorize(
  event: IpcMainInvokeEvent | IpcMainEvent,
  roles: WindowRole[],
): void {
  const trusted = getTrustedWindow(event.sender)
  if (!trusted || !roles.includes(trusted.role)) {
    throw new IpcError('UNAUTHORIZED', 'Dieser IPC-Aufruf ist für dieses Fenster nicht erlaubt.')
  }
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new IpcError('UNAUTHORIZED', 'IPC-Aufrufe aus Unterframes sind nicht erlaubt.')
  }
  if (!isTrustedRendererUrl(event.senderFrame.url)) {
    throw new IpcError('UNAUTHORIZED', 'IPC-Aufrufe sind nur aus der Launcher-Oberfläche erlaubt.')
  }
}

function toErrorDto(error: unknown): IpcErrorDto {
  if (error instanceof IpcError) return { code: error.code, message: error.message }
  if (error instanceof ValidationError) return { code: 'INVALID_PAYLOAD', message: error.message }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'CANCELLED', message: 'Der Vorgang wurde abgebrochen.' }
  }
  return {
    code: 'INTERNAL',
    message: 'Ein interner Fehler ist aufgetreten. Weitere Details stehen im Launcher-Log.',
  }
}

export function secureHandle<TPayload = undefined, TResult = void>(
  channel: string,
  options: HandlerOptions<TPayload>,
  handler: (event: IpcMainInvokeEvent, payload: TPayload) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, async (event, rawPayload): Promise<IpcResponse<TResult>> => {
    try {
      authorize(event, options.roles ?? ['launcher'])
      const payload = options.validate
        ? options.validate(rawPayload)
        : rawPayload as TPayload
      return { ok: true, value: await handler(event, payload) }
    } catch (error) {
      const dto = toErrorDto(error)
      if (dto.code === 'INTERNAL') logger.error(`[IPC] ${channel} failed:`, error)
      else logger.warn(`[IPC] ${channel} rejected (${dto.code}): ${dto.message}`)
      return { ok: false, error: dto }
    }
  })
}

export function secureOn<TPayload = undefined>(
  channel: string,
  options: HandlerOptions<TPayload>,
  handler: (event: IpcMainEvent, payload: TPayload) => void | Promise<void>,
): void {
  ipcMain.on(channel, (event, rawPayload) => {
    try {
      authorize(event, options.roles ?? ['launcher'])
      const payload = options.validate
        ? options.validate(rawPayload)
        : rawPayload as TPayload
      void Promise.resolve(handler(event, payload)).catch((error: unknown) => {
        const dto = toErrorDto(error)
        if (dto.code === 'INTERNAL') logger.error(`[IPC] ${channel} failed:`, error)
        else logger.warn(`[IPC] ${channel} failed (${dto.code}): ${dto.message}`)
      })
    } catch (error) {
      const dto = toErrorDto(error)
      if (dto.code === 'INTERNAL') logger.error(`[IPC] ${channel} failed:`, error)
      else logger.warn(`[IPC] ${channel} rejected (${dto.code}): ${dto.message}`)
    }
  })
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Die IPC-Nutzlast muss ein Objekt sein.')
  }
  return value as Record<string, unknown>
}

export function noPayload(value: unknown): undefined {
  if (value !== undefined && value !== null) {
    throw new ValidationError('Dieser IPC-Aufruf akzeptiert keine Nutzlast.')
  }
  return undefined
}
