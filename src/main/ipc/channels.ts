/**
 * IPC channel name constants.
 * All invoke() calls and push event names must use these constants.
 * Organised to mirror IpcTopics.java topics.
 */
export const IpcChannels = {
  // ── Auth ────────────────────────────────────────────────────
  /** Renderer→Main: Start Microsoft OAuth flow */
  AUTH_START_MICROSOFT: 'auth:start-microsoft',
  /** Renderer→Main: Log out current profile */
  AUTH_LOGOUT: 'auth:logout',
  /** Renderer→Main: Switch active profile */
  AUTH_SWITCH_PROFILE: 'auth:switch-profile',
  /** Main→Renderer push: profile list updated */
  AUTH_PROFILES_UPDATED: 'auth:profiles-updated',
  /** Main→Renderer push: login error */
  AUTH_LOGIN_ERROR: 'auth:login-error',

  // ── Packs API ────────────────────────────────────────────────
  /** Renderer→Main: Get remote pack list */
  PACKS_GET_REMOTE: 'packs:get-remote',
  /** Renderer→Main: Get full manifest for a pack */
  PACKS_GET_MANIFEST: 'packs:get-manifest',
  /** Renderer→Main: Get blog posts */
  PACKS_GET_POSTS: 'packs:get-posts',
  /** Renderer→Main: Get pack logo (returns base64 data URL or null) */
  PACKS_GET_LOGO: 'packs:get-logo',

  // ── Install ──────────────────────────────────────────────────
  /** Renderer→Main: Install a modpack */
  INSTALL_MODPACK: 'install:modpack',
  /** Renderer→Main: Cancel in-progress install */
  INSTALL_CANCEL: 'install:cancel',
  /** Renderer→Main: Get list of installed pack names */
  INSTALL_GET_INSTALLED: 'install:get-installed',
  /** Main→Renderer push: installation progress */
  INSTALL_PROGRESS: 'install:progress',
  /** Main→Renderer push: installation finished */
  INSTALL_COMPLETE: 'install:complete',
  /**
   * Main→Renderer push: modpack has optional features,
   * renderer must re-call INSTALL_MODPACK with selectedFeatures
   */
  INSTALL_NEEDS_FEATURES: 'install:needs-features',

  // ── Launch ───────────────────────────────────────────────────
  /** Renderer→Main: Launch a modpack */
  LAUNCH_START: 'launch:start',
  /** Renderer→Main: Kill running Minecraft process */
  LAUNCH_KILL: 'launch:kill',
  /** Renderer→Main: Get current log buffer */
  LAUNCH_GET_LOG: 'launch:get-log',
  /** Renderer→Main: Open modpack instance folder */
  LAUNCH_OPEN_FOLDER: 'launch:open-folder',
  /** Renderer→Main: Delete installed modpack */
  LAUNCH_DELETE_PACK: 'launch:delete-pack',
  /** Renderer→Main: Create desktop shortcut */
  LAUNCH_CREATE_SHORTCUT: 'launch:create-shortcut',
  /** Renderer→Main: Upload latest crash report to paste */
  LAUNCH_UPLOAD_CRASH: 'launch:upload-crash',
  /** Renderer→Main: Upload current log to paste */
  LAUNCH_UPLOAD_LOG: 'launch:upload-log',
  /** Main→Renderer push: Minecraft process state change */
  LAUNCH_STATE: 'launch:state',
  /** Main→Renderer push: Minecraft stdout/stderr line */
  LAUNCH_LOG: 'launch:log',

  // ── Config ───────────────────────────────────────────────────
  /** Renderer→Main: Get current launcher config */
  CONFIG_GET: 'config:get',
  /** Renderer→Main: Save launcher config (partial merge) */
  CONFIG_SAVE: 'config:save',
  /** Renderer→Main: Open OS directory picker dialog */
  CONFIG_PICK_DIR: 'config:pick-dir',
  /** Renderer→Main: Open launcher log file directory */
  CONFIG_OPEN_LOGS: 'config:open-logs',

  // ── System ───────────────────────────────────────────────────
  /** Renderer→Main: Get system info (platform, memory, etc.) */
  SYSTEM_INFO: 'system:info',
  /** Renderer→Main: Open external URL in default browser */
  SYSTEM_OPEN_URL: 'system:open-url',

  // ── Internal ─────────────────────────────────────────────────
  /** Renderer→Main: Renderer is ready (first-start detection, launch-pack arg) */
  RENDERER_ARRIVED: 'internal:renderer-arrived',
  /** Main→Renderer push: Show welcome/first-start modal */
  WELCOME_MESSAGE: 'internal:welcome-message',
  /** Main→Renderer push: Auto-launch pack from --pack CLI arg or webstart */
  LAUNCH_PACK: 'internal:launch-pack',
} as const

export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels]
