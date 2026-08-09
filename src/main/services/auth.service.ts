import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dialog, shell } from 'electron'

import { configService } from './config.service'
import { credentialService, type AuthCredential } from './credential.service'
import { IpcChannels } from '../ipc/channels'
import { secureHandle, noPayload, IpcError } from '../ipc/security'
import { Constants } from '../constants'
import type {
  AuthenticatedProfile,
  AuthProfileSummary,
  AuthProfilesUpdatedEvent,
} from '../../shared/types'
import { assertUuid, validateAuthSwitchProfilePayload } from '../../shared/validation'
import { getMainWindow } from '../app-state'
import { logger } from '../logger'

const CLIENT_ID = Constants.microsoftLoginClientId
const OAUTH_SCOPE = Constants.microsoftOAuthScope
const REDIRECT_PORT = Constants.microsoftOAuthRedirectPort
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/login_callback`
const CALLBACK_TIMEOUT_MS = 5 * 60_000

const MS_OAUTH_AUTHORIZE = 'https://login.live.com/oauth20_authorize.srf'
const MS_OAUTH_TOKEN = 'https://login.live.com/oauth20_token.srf'
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_XBOX_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

type AuthServiceName = 'Microsoft' | 'Xbox Live' | 'Minecraft'
type AuthFailureKind = 'temporary' | 'rejected' | 'invalid-profile'

export class AuthFlowError extends Error {
  constructor(
    readonly service: AuthServiceName,
    readonly kind: AuthFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AuthFlowError'
  }
}

interface OauthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}
interface XboxAuthResponse {
  Token: string
  DisplayClaims: { xui: Array<{ uhs: string }> }
}
interface MinecraftAuthResponse {
  access_token: string
  expires_in: number
}
interface MinecraftProfileResponse { id: string; name: string }
interface LoginResult { summary: AuthProfileSummary; credential: AuthCredential }

function isTemporaryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function requestJson<T>(
  service: AuthServiceName,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(Constants.connectTimeoutMs),
    })
  } catch (error) {
    const temporary = error instanceof Error
      && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)
    throw new AuthFlowError(
      service,
      temporary ? 'temporary' : 'rejected',
      `${service} ist derzeit nicht erreichbar.`,
    )
  }

  if (!response.ok) {
    // Never include upstream bodies: OAuth responses can contain credentials.
    const kind: AuthFailureKind = isTemporaryStatus(response.status) ? 'temporary' : 'rejected'
    throw new AuthFlowError(
      service,
      kind,
      kind === 'temporary'
        ? `${service} ist vorübergehend nicht verfügbar (HTTP ${response.status}).`
        : `Die Anmeldung bei ${service} wurde abgelehnt (HTTP ${response.status}).`,
      response.status,
    )
  }

  try {
    return await response.json() as T
  } catch {
    throw new AuthFlowError(service, 'temporary', `${service} hat eine ungültige Antwort gesendet.`)
  }
}

async function fetchOauthTokens(
  codeOrRefreshToken: string,
  isRefresh: boolean,
  codeVerifier?: string,
): Promise<OauthTokenResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    [isRefresh ? 'refresh_token' : 'code']: codeOrRefreshToken,
    grant_type: isRefresh ? 'refresh_token' : 'authorization_code',
    redirect_uri: isRefresh ? '' : REDIRECT_URI,
    scope: OAUTH_SCOPE,
  })
  if (!isRefresh && codeVerifier) body.set('code_verifier', codeVerifier)
  return requestJson('Microsoft', MS_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}

async function doXblAuthenticate(msAccessToken: string): Promise<XboxAuthResponse> {
  return requestJson('Xbox Live', XBL_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
    }),
  })
}

async function doXstsAuthenticate(xblToken: string): Promise<XboxAuthResponse> {
  return requestJson('Xbox Live', XSTS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    }),
  })
}

async function doMinecraftXboxAuthenticate(
  xstsToken: string,
  userHash: string,
): Promise<MinecraftAuthResponse> {
  return requestJson('Minecraft', MC_XBOX_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xstsToken}` }),
  })
}

async function fetchMinecraftProfile(accessToken: string): Promise<MinecraftProfileResponse> {
  return requestJson('Minecraft', MC_PROFILE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

function normalizeUuid(rawId: string): string {
  const withDashes = rawId.includes('-')
    ? rawId
    : `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}`
  return assertUuid(withDashes)
}

async function loginFlow(
  codeOrRefreshToken: string,
  isRefresh: boolean,
  codeVerifier?: string,
): Promise<LoginResult> {
  const oauth = await fetchOauthTokens(codeOrRefreshToken, isRefresh, codeVerifier)
  const xbl = await doXblAuthenticate(oauth.access_token)
  const xsts = await doXstsAuthenticate(xbl.Token)
  const userHash = xsts.DisplayClaims.xui[0]?.uhs
  if (!userHash) throw new AuthFlowError('Xbox Live', 'rejected', 'Xbox Live hat keine Benutzer-ID geliefert.')
  const minecraft = await doMinecraftXboxAuthenticate(xsts.Token, userHash)
  const profile = await fetchMinecraftProfile(minecraft.access_token)
  if (!profile.id || !profile.name) {
    throw new AuthFlowError('Minecraft', 'invalid-profile', 'Dieses Konto besitzt kein gültiges Minecraft-Profil.')
  }
  const now = Date.now()
  return {
    summary: {
      provider: 'microsoft',
      uuid: normalizeUuid(profile.id),
      lastKnownUsername: profile.name,
      minecraftTokenExpiresAt: now + Math.max(0, minecraft.expires_in) * 1_000,
      lastAuthenticatedAt: now,
    },
    credential: {
      minecraftAccessToken: minecraft.access_token,
      oauthRefreshToken: oauth.refresh_token || (isRefresh ? codeOrRefreshToken : ''),
    },
  }
}

function pushProfilesUpdated(): void {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return
  const { profiles, selectedProfileUuid } = configService.get().profileStore
  const payload: AuthProfilesUpdatedEvent = { profiles, selectedUuid: selectedProfileUuid }
  window.webContents.send(IpcChannels.AUTH_PROFILES_UPDATED, payload)
}

async function persistProfile(result: LoginResult, preserveUuid?: string): Promise<AuthenticatedProfile> {
  if (preserveUuid && result.summary.uuid !== preserveUuid) {
    throw new AuthFlowError('Microsoft', 'rejected', 'Die erneuerte Anmeldung gehört zu einem anderen Minecraft-Profil.')
  }
  const summary = result.summary
  const config = configService.get()
  const profiles = config.profileStore.profiles.filter((entry) => entry.uuid !== summary.uuid)

  // Persist encrypted credentials first. An orphaned encrypted entry is safer
  // than profile metadata that points at missing credentials.
  await credentialService.set(summary.uuid, result.credential)
  configService.merge({
    profileStore: {
      profiles: [...profiles, summary],
      selectedProfileUuid: config.profileStore.selectedProfileUuid ?? summary.uuid,
    },
  })
  await configService.save()
  return { ...summary, ...result.credential }
}

function waitForOauthCallback(expectedState: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const server = http.createServer()
    const timeout = setTimeout(() => finish(new AuthFlowError(
      'Microsoft',
      'temporary',
      'Die Microsoft-Anmeldung hat zu lange gedauert.',
    )), CALLBACK_TIMEOUT_MS)

    const cleanup = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      server.removeAllListeners()
      if (server.listening) server.close()
    }
    const finish = (error?: Error, code?: string): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(code!)
    }
    const onAbort = (): void => finish(new DOMException('OAuth flow aborted', 'AbortError'))

    server.on('request', (request, response) => {
      if (settled) {
        response.writeHead(410).end()
        return
      }
      try {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${REDIRECT_PORT}`)
        if (url.pathname !== '/login_callback') {
          response.writeHead(404).end()
          return
        }
        const oauthError = url.searchParams.get('error')
        if (oauthError) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(buildCallbackHtml(false, 'Die Anmeldung wurde abgebrochen oder abgelehnt.'))
          finish(new AuthFlowError('Microsoft', 'rejected', 'Die Microsoft-Anmeldung wurde abgelehnt.'))
          return
        }
        if (url.searchParams.get('state') !== expectedState) {
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(buildCallbackHtml(false, 'Ungültiger Sicherheitsstatus.'))
          finish(new AuthFlowError('Microsoft', 'rejected', 'OAuth-Sicherheitsstatus stimmt nicht überein.'))
          return
        }
        const code = url.searchParams.get('code')
        if (!code) {
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(buildCallbackHtml(false, 'Kein Anmeldecode empfangen.'))
          finish(new AuthFlowError('Microsoft', 'rejected', 'Microsoft hat keinen Anmeldecode geliefert.'))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(buildCallbackHtml(true))
        finish(undefined, code)
      } catch {
        response.writeHead(500).end()
        finish(new AuthFlowError('Microsoft', 'temporary', 'Der lokale Anmelde-Callback ist fehlgeschlagen.'))
      }
    })
    server.once('error', () => finish(new AuthFlowError(
      'Microsoft',
      'temporary',
      'Der lokale Microsoft-Anmeldeport ist nicht verfügbar.',
    )))
    signal.addEventListener('abort', onAbort, { once: true })
    server.listen(REDIRECT_PORT, '127.0.0.1')
  })
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildCallbackHtml(success: boolean, errorMessage?: string): string {
  const heading = success ? 'Anmeldung erfolgreich' : 'Anmeldung fehlgeschlagen'
  const message = success
    ? 'Du kannst diesen Tab schließen und zum Launcher zurückkehren.'
    : escapeHtml(errorMessage ?? 'Bitte versuche es im Launcher erneut.')
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>MyFTB Launcher</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a1a;color:#fff"><h2>${heading}</h2><p>${message}</p></body></html>`
}

class AuthService {
  private activeFlowController: AbortController | null = null
  private readonly refreshFlights = new Map<string, Promise<AuthenticatedProfile>>()

  isBusy(): boolean {
    return this.activeFlowController !== null || this.refreshFlights.size > 0
  }

  private async refreshProfile(summary: AuthProfileSummary): Promise<AuthenticatedProfile> {
    const existing = this.refreshFlights.get(summary.uuid)
    if (existing) return existing
    const operation = (async () => {
      const credential = credentialService.get(summary.uuid)
      if (!credential?.oauthRefreshToken) {
        throw new AuthFlowError('Microsoft', 'rejected', 'Für dieses Profil sind keine Anmeldedaten gespeichert.')
      }
      const result = await loginFlow(credential.oauthRefreshToken, true)
      const refreshed = await persistProfile(result, summary.uuid)
      pushProfilesUpdated()
      return refreshed
    })()
    this.refreshFlights.set(summary.uuid, operation)
    try {
      return await operation
    } finally {
      if (Object.is(this.refreshFlights.get(summary.uuid), operation)) this.refreshFlights.delete(summary.uuid)
    }
  }

  async getSelectedProfileForLaunch(): Promise<AuthenticatedProfile> {
    const { profiles, selectedProfileUuid } = configService.get().profileStore
    if (!selectedProfileUuid) throw new IpcError('AUTH_REJECTED', 'Kein Microsoft-Profil ist ausgewählt.')
    const summary = profiles.find((profile) => profile.uuid === selectedProfileUuid)
    if (!summary) throw new IpcError('AUTH_REJECTED', 'Das ausgewählte Profil wurde nicht gefunden.')

    for (;;) {
      try {
        return await this.refreshProfile(summary)
      } catch (error) {
        if (!(error instanceof AuthFlowError) || error.kind !== 'temporary') {
          const window = getMainWindow()
          const options = {
            type: 'error' as const,
            title: 'Anmeldung fehlgeschlagen',
            message: error instanceof Error ? error.message : 'Die Anmeldung wurde abgelehnt.',
            detail: 'Bitte melde das Konto in den Einstellungen erneut an.',
            buttons: ['OK'],
          }
          if (window) await dialog.showMessageBox(window, options)
          else await dialog.showMessageBox(options)
          throw new IpcError('AUTH_REJECTED', error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen.')
        }

        const cached = credentialService.get(summary.uuid)
        const offlineEligible = !!cached?.minecraftAccessToken && !!summary.lastAuthenticatedAt
        const buttons = offlineEligible
          ? ['Erneut versuchen', 'Offline starten', 'Abbrechen']
          : ['Erneut versuchen', 'Abbrechen']
        const window = getMainWindow()
        const options = {
          type: 'warning' as const,
          title: `${error.service} nicht erreichbar`,
          message: error.message,
          detail: offlineEligible
            ? 'Du kannst einmalig offline starten. Multiplayer, Skins und andere Online-Funktionen können dabei ausfallen.'
            : 'Für dieses Profil ist kein zuvor bestätigter Offline-Login verfügbar.',
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
          noLink: true,
        }
        const choice = window
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options)
        if (choice.response === 0) continue
        if (offlineEligible && choice.response === 1) {
          logger.warn(`[AuthService] One-time offline launch selected for ${summary.lastKnownUsername}`)
          return { ...summary, ...cached! }
        }
        throw new IpcError('CANCELLED', 'Der Start wurde abgebrochen.')
      }
    }
  }

  registerHandlers(): void {
    secureHandle(IpcChannels.AUTH_START_MICROSOFT, { validate: noPayload }, async () => {
      if (configService.isDataDirMigrationActive()) {
        throw new IpcError('CONFLICT', 'Während der Datenmigration ist keine Anmeldung möglich.')
      }
      this.activeFlowController?.abort()
      const controller = new AbortController()
      this.activeFlowController = controller
      let callbackPromise: Promise<string> | null = null
      try {
        const state = randomUUID()
        const verifier = randomBytes(48).toString('base64url')
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        const authUrl = new URL(MS_OAUTH_AUTHORIZE)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('client_id', CLIENT_ID)
        authUrl.searchParams.set('state', state)
        authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
        authUrl.searchParams.set('scope', OAUTH_SCOPE)
        authUrl.searchParams.set('code_challenge', challenge)
        authUrl.searchParams.set('code_challenge_method', 'S256')

        callbackPromise = waitForOauthCallback(state, controller.signal)
        await shell.openExternal(authUrl.toString())
        const code = await callbackPromise
        const result = await loginFlow(code, false, verifier)
        const profile = await persistProfile(result)
        logger.info(`[AuthService] Login successful: ${profile.lastKnownUsername} (${profile.uuid})`)
        pushProfilesUpdated()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Die Microsoft-Anmeldung ist fehlgeschlagen.'
        logger.warn(`[AuthService] Login failed: ${message}`)
        getMainWindow()?.webContents.send(IpcChannels.AUTH_LOGIN_ERROR, {
          error: message,
          code: error instanceof Error && error.name === 'AbortError'
            ? 'CANCELLED'
            : error instanceof AuthFlowError && error.kind === 'temporary'
              ? 'NETWORK_TEMPORARY'
              : 'AUTH_REJECTED',
        })
        throw error
      } finally {
        controller.abort()
        await callbackPromise?.catch(() => {})
        if (this.activeFlowController === controller) this.activeFlowController = null
      }
    })

    secureHandle(IpcChannels.AUTH_LOGOUT, { validate: noPayload }, async () => {
      if (configService.isDataDirMigrationActive()) {
        throw new IpcError('CONFLICT', 'Während der Datenmigration können Accounts nicht geändert werden.')
      }
      const config = configService.get()
      const selected = config.profileStore.selectedProfileUuid
      const profiles = config.profileStore.profiles.filter((profile) => profile.uuid !== selected)
      configService.merge({
        profileStore: {
          profiles,
          selectedProfileUuid: profiles.at(-1)?.uuid,
        },
      })
      await configService.save()
      if (selected) await credentialService.delete(selected)
      pushProfilesUpdated()
    })

    secureHandle(
      IpcChannels.AUTH_SWITCH_PROFILE,
      { validate: validateAuthSwitchProfilePayload },
      async (_event, { uuid }) => {
        if (configService.isDataDirMigrationActive()) {
          throw new IpcError('CONFLICT', 'Während der Datenmigration können Accounts nicht geändert werden.')
        }
        const config = configService.get()
        const profile = config.profileStore.profiles.find((entry) => entry.uuid === uuid)
        if (!profile) throw new IpcError('NOT_FOUND', 'Dieses Profil ist nicht bekannt.')
        configService.merge({
          profileStore: { ...config.profileStore, selectedProfileUuid: uuid },
        })
        await configService.save()
        pushProfilesUpdated()
      },
    )
  }
}

export const authService = new AuthService()
export async function getSelectedProfile(): Promise<AuthenticatedProfile> {
  return authService.getSelectedProfileForLaunch()
}
