import { Constants } from '../constants'

// ─── Service ─────────────────────────────────────────────────────────────────

class PasteService {
  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Hook for IPC handler registration.  No IPC handlers are needed for the
   * paste service; this method exists so the service follows the same
   * lifecycle contract as every other service (called by router.ts).
   */
  registerHandlers(): void {
    // No IPC handlers needed.
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Upload raw text or binary content to the MyFTB paste service.
   *
   * POSTs `content` as the raw request body to `<pasteTarget>/documents`,
   * parses the `{ key: string }` JSON response, and returns the full
   * shareable URL `<pasteTarget>/<key>`.
   *
   * @throws {Error} when the HTTP request fails or the response is not a
   *   valid `{ key }` object.
   */
  async upload(content: string | Buffer): Promise<string> {
    const endpoint = `${Constants.pasteTarget}/documents`

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        body: typeof content === 'string' ? content : new Uint8Array(content),
      })
    } catch (err: unknown) {
      throw new Error(
        `[PasteService] Network error while uploading to ${endpoint}: ${String(err)}`,
      )
    }

    if (!response.ok) {
      throw new Error(
        `[PasteService] Upload failed - HTTP ${response.status} ${response.statusText} (${endpoint})`,
      )
    }

    let data: unknown
    try {
      data = await response.json()
    } catch (err: unknown) {
      throw new Error(
        `[PasteService] Failed to parse JSON response from ${endpoint}: ${String(err)}`,
      )
    }

    if (
      data === null ||
      typeof data !== 'object' ||
      !('key' in data) ||
      typeof (data as Record<string, unknown>).key !== 'string'
    ) {
      throw new Error(
        `[PasteService] Unexpected response shape from ${endpoint}: ${JSON.stringify(data)}`,
      )
    }

    const key = (data as { key: string }).key
    return `${Constants.pasteTarget}/${key}`
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const pasteService = new PasteService()
