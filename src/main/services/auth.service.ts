import http from 'node:http'
import { ipcMain, shell } from 'electron'

import { configService } from './config.service'
import { IpcChannels } from '../ipc/channels'
import { Constants } from '../constants'
import { LauncherProfile, AuthProfilesUpdatedEvent } from '../../shared/types'
import { getMainWindow } from '../app-state'
import { logger } from '../logger'

// ─── OAuth / Auth API constants ──────────────────────────────────────────────

const CLIENT_ID = Constants.microsoftLoginClientId
const OAUTH_SCOPE = Constants.microsoftOAuthScope
const REDIRECT_PORT = Constants.microsoftOAuthRedirectPort
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/login_callback`

const MS_OAUTH_AUTHORIZE = 'https://login.live.com/oauth20_authorize.srf'
const MS_OAUTH_TOKEN = 'https://login.live.com/oauth20_token.srf'
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_XBOX_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

// ─── Response shape interfaces (internal) ────────────────────────────────────

interface OauthTokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

interface XboxAuthResponse {
  Token: string
  DisplayClaims: {
    xui: Array<{ uhs: string }>
  }
}

interface MinecraftAuthResponse {
  access_token: string
  token_type: string
  expires_in: number
}

interface MinecraftProfileResponse {
  id: string
  name: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Push the current profile list to the renderer. */
function pushProfilesUpdated(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return

  const { profiles, selectedProfileUuid } = configService.get().profileStore
  const payload: AuthProfilesUpdatedEvent = {
    profiles,
    selectedUuid: selectedProfileUuid,
  }
  win.webContents.send(IpcChannels.AUTH_PROFILES_UPDATED, payload)
}

/** Persist a profile list back into config (upsert by uuid). */
async function saveProfile(profile: LauncherProfile): Promise<void> {
  const config = configService.get()
  const existing = config.profileStore.profiles.filter((p) => p.uuid !== profile.uuid)
  configService.merge({
    profileStore: {
      ...config.profileStore,
      profiles: [...existing, profile],
      // Keep selectedProfileUuid pointing at this profile on first login
      selectedProfileUuid: config.profileStore.selectedProfileUuid ?? profile.uuid,
    },
  })
  await configService.save()
}

// ─── Step 2: Exchange code / refresh token for Microsoft OAuth tokens ─────────

async function fetchOauthTokens(
  code: string,
  isRefresh: boolean,
): Promise<OauthTokenResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    [isRefresh ? 'refresh_token' : 'code']: code,
    grant_type: isRefresh ? 'refresh_token' : 'authorization_code',
    redirect_uri: isRefresh ? '' : REDIRECT_URI,
    scope: OAUTH_SCOPE,
  })

  const response = await fetch(MS_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(Constants.connectTimeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(`Microsoft OAuth token request failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<OauthTokenResponse>
}

// ─── Step 3: XBL authentication ──────────────────────────────────────────────

async function doXblAuthenticate(msAccessToken: string): Promise<XboxAuthResponse> {
  const payload = {
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`,
    },
  }

  const response = await fetch(XBL_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Constants.connectTimeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(`XBL authentication failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<XboxAuthResponse>
}

// ─── Step 4: XSTS authentication ─────────────────────────────────────────────

async function doXstsAuthenticate(xblToken: string): Promise<XboxAuthResponse> {
  const payload = {
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xblToken],
    },
  }

  const response = await fetch(XSTS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Constants.connectTimeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(`XSTS authentication failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<XboxAuthResponse>
}

// ─── Step 5: Minecraft Xbox login ────────────────────────────────────────────

async function doMinecraftXboxAuthenticate(
  xstsToken: string,
  userHash: string,
): Promise<MinecraftAuthResponse> {
  const payload = {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
  }

  const response = await fetch(MC_XBOX_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Constants.connectTimeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(`Minecraft-Xbox authentication failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<MinecraftAuthResponse>
}

// ─── Minecraft profile fetch ──────────────────────────────────────────────────

async function fetchMinecraftProfile(
  mcAccessToken: string,
): Promise<MinecraftProfileResponse> {
  const response = await fetch(MC_PROFILE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${mcAccessToken}` },
    signal: AbortSignal.timeout(Constants.connectTimeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(`Minecraft profile fetch failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<MinecraftProfileResponse>
}

// ─── Full login flow (steps 2–5 + profile) ───────────────────────────────────

/**
 * Execute the complete Microsoft → XBL → XSTS → Minecraft auth chain.
 *
 * @param code  Either the OAuth authorization code (isRefresh=false) or the
 *              stored OAuth refresh token (isRefresh=true).
 * @param isRefresh  When true the `refresh_token` grant is used.
 */
async function loginFlow(code: string, isRefresh: boolean): Promise<LauncherProfile> {
  // Step 2 — OAuth tokens
  const oauthResponse = await fetchOauthTokens(code, isRefresh)

  // Step 3 — XBL
  const xblResponse = await doXblAuthenticate(oauthResponse.access_token)

  // Step 4 — XSTS
  const xstsResponse = await doXstsAuthenticate(xblResponse.Token)

  const userHash = xstsResponse.DisplayClaims.xui[0]?.uhs
  if (!userHash) {
    throw new Error('XSTS response did not contain a user hash (uhs)')
  }

  // Step 5 — Minecraft
  const mcAuth = await doMinecraftXboxAuthenticate(xstsResponse.Token, userHash)

  // Minecraft profile
  const mcProfile = await fetchMinecraftProfile(mcAuth.access_token)

  if (!mcProfile.id || !mcProfile.name) {
    throw new Error('This Microsoft account does not have a valid Minecraft profile')
  }

  // Normalise UUID: insert dashes if the API returns a raw 32-char hex string
  const rawId = mcProfile.id
  const uuid =
    rawId.includes('-')
      ? rawId
      : `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}`

  const profile: LauncherProfile = {
    provider: 'microsoft',
    uuid,
    lastKnownUsername: mcProfile.name,
    minecraftAccessToken: mcAuth.access_token,
    oauthRefreshToken: oauthResponse.refresh_token,
  }

  return profile
}

// ─── Token refresh ────────────────────────────────────────────────────────────

/**
 * Refresh all tokens for the given profile using its stored OAuth refresh
 * token, and return a new `LauncherProfile` with updated tokens.
 */
export async function refreshProfile(profile: LauncherProfile): Promise<LauncherProfile> {
  if (!profile.oauthRefreshToken) {
    throw new Error('Profile has no OAuth refresh token; cannot refresh')
  }

  logger.debug(`[AuthService] Refreshing tokens for ${profile.lastKnownUsername}`)
  const refreshed = await loginFlow(profile.oauthRefreshToken, true)
  logger.debug(`[AuthService] Token refresh successful for ${refreshed.lastKnownUsername}`)

  // Carry forward identity fields that won't change during a token refresh
  return {
    ...refreshed,
    uuid: profile.uuid,
  }
}

// ─── Step 1: OAuth callback HTTP server ──────────────────────────────────────

/**
 * Start a single-use HTTP server on REDIRECT_PORT that captures the `code`
 * query parameter from the Microsoft OAuth redirect and resolves the promise.
 *
 * The server closes itself after the first successful callback (or after the
 * returned abort signal fires).
 */
function waitForOauthCallback(
  expectedState: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlObj = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`)

        if (urlObj.pathname !== '/login_callback') {
          res.writeHead(404).end()
          return
        }

        const error = urlObj.searchParams.get('error')
        if (error) {
          const desc = urlObj.searchParams.get('error_description') ?? error
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
            buildCallbackHtml(false, desc),
          )
          server.close()
          reject(new Error(`OAuth error: ${desc}`))
          return
        }

        const returnedState = urlObj.searchParams.get('state')
        if (returnedState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
            buildCallbackHtml(false, 'Invalid state parameter — possible CSRF attempt.'),
          )
          server.close()
          reject(new Error('OAuth state mismatch'))
          return
        }

        const code = urlObj.searchParams.get('code')
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
            buildCallbackHtml(false, 'No authorization code received.'),
          )
          server.close()
          reject(new Error('No authorization code in OAuth callback'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          buildCallbackHtml(true),
        )
        server.close()
        resolve(code)
      } catch (err) {
        res.writeHead(500).end()
        server.close()
        reject(err)
      }
    })

    server.on('error', (err) => {
      reject(new Error(`OAuth callback server error: ${err.message}`))
    })

    server.listen(REDIRECT_PORT, '127.0.0.1')

    // Abort handling: close the server if the caller cancels the flow
    signal.addEventListener('abort', () => {
      server.close()
      reject(new Error('OAuth flow aborted'))
    })
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Generate a minimal self-closing HTML page shown in the user's browser. */
function buildCallbackHtml(success: boolean, errorMessage?: string): string {
  if (success) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MyFTB Launcher</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a1a;color:#fff">
  <h2>Login successful!</h2>
  <p>You can close this tab and return to the launcher.</p>
</body></html>`
  }
  const safeMessage = escapeHtml(errorMessage ?? 'An unknown error occurred.')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MyFTB Launcher</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a1a;color:#fff">
  <h2>Login failed</h2>
  <p>${safeMessage}</p>
  <p>Please close this tab and try again from the launcher.</p>
</body></html>`
}

// ─── Public helper ────────────────────────────────────────────────────────────

/**
 * Return the currently selected profile with an up-to-date Minecraft access
 * token.  Automatically refreshes via the stored OAuth refresh token and
 * persists the updated profile before returning.
 *
 * @throws if no profile is selected or the token refresh fails.
 */
export async function getSelectedProfile(): Promise<LauncherProfile> {
  const { profiles, selectedProfileUuid } = configService.get().profileStore

  if (!selectedProfileUuid) {
    throw new Error('No profile selected')
  }

  const profile = profiles.find((p) => p.uuid === selectedProfileUuid)
  if (!profile) {
    throw new Error(`Selected profile UUID "${selectedProfileUuid}" not found in store`)
  }

  // Always refresh tokens before handing the profile to a caller, so that
  // the Minecraft access token is fresh when launching the game.
  const refreshed = await refreshProfile(profile)
  await saveProfile(refreshed)

  return refreshed
}

// ─── Service class ────────────────────────────────────────────────────────────

class AuthService {
  /** Active OAuth flow abort controller — prevents more than one concurrent flow. */
  private activeFlowController: AbortController | null = null

  registerHandlers(): void {
    // ── auth:start-microsoft ──────────────────────────────────────────────────
    ipcMain.handle(IpcChannels.AUTH_START_MICROSOFT, async () => {
      // Abort any already-running OAuth flow
      if (this.activeFlowController) {
        this.activeFlowController.abort()
        this.activeFlowController = null
      }

      const controller = new AbortController()
      this.activeFlowController = controller

      try {
        // Generate a CSRF-protection state value
        const state = crypto.randomUUID()

        // Build the Microsoft authorization URL
        const authUrl = new URL(MS_OAUTH_AUTHORIZE)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('client_id', CLIENT_ID)
        authUrl.searchParams.set('state', state)
        authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
        authUrl.searchParams.set('scope', OAUTH_SCOPE)

        logger.info('[AuthService] Microsoft login started - opening browser')

        // Start callback server before opening browser so the redirect is
        // always captured even when the browser responds very quickly.
        const codePromise = waitForOauthCallback(state, controller.signal)

        // Step 1 — Open browser
        await shell.openExternal(authUrl.toString())

        // Wait for the OAuth callback
        const code = await codePromise

        // Steps 2–5 + profile
        const profile = await loginFlow(code, false)

        await saveProfile(profile)
        logger.info(`[AuthService] Login successful: ${profile.lastKnownUsername} (${profile.uuid})`)
        pushProfilesUpdated()
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Microsoft login failed'

        logger.error('[AuthService] Login failed:', err)

        // Push an error event so the renderer can surface it in the UI
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(IpcChannels.AUTH_LOGIN_ERROR, { error: message })
        }

        throw err
      } finally {
        this.activeFlowController = null
      }
    })

    // ── auth:logout ───────────────────────────────────────────────────────────
    ipcMain.handle(IpcChannels.AUTH_LOGOUT, async () => {
      const config = configService.get()
      const { profiles, selectedProfileUuid } = config.profileStore

      const leaving = profiles.find((p) => p.uuid === selectedProfileUuid)
      const remaining = profiles.filter((p) => p.uuid !== selectedProfileUuid)
      const nextSelected = remaining.length > 0 ? remaining[remaining.length - 1].uuid : undefined

      configService.merge({
        profileStore: {
          profiles: remaining,
          selectedProfileUuid: nextSelected,
        },
      })
      await configService.save()
      logger.info(`[AuthService] Profile logged out: ${leaving?.lastKnownUsername ?? selectedProfileUuid}`)
      pushProfilesUpdated()
    })

    // ── auth:switch-profile ───────────────────────────────────────────────────
    ipcMain.handle(IpcChannels.AUTH_SWITCH_PROFILE, async (_event, uuid: string) => {
      const config = configService.get()
      const profile = config.profileStore.profiles.find((p) => p.uuid === uuid)

      if (!profile) {
        throw new Error(`Cannot switch to unknown profile UUID: ${uuid}`)
      }

      configService.merge({
        profileStore: {
          ...config.profileStore,
          selectedProfileUuid: uuid,
        },
      })
      await configService.save()
      logger.info(`[AuthService] Switched to profile: ${profile.lastKnownUsername} (${uuid})`)
      pushProfilesUpdated()
    })
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const authService = new AuthService()
