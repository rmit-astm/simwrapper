/**
 * Parent/iframe bridge for the FASTrack shell. The protocol is mirrored in
 * FASTrack's src/viewerProtocol.ts; see FASTrack/VIEWER_PROTOCOL.md.
 */

const PROTOCOL_VERSION = 1
const AUTH_TIMEOUT_MS = 10000

let readySent = false
let authPromise: Promise<{ token: string; username: string }> | null = null

export function announceViewerReady(): void {
  if (readySent || window.parent === window) return
  readySent = true
  window.parent.postMessage({ v: PROTOCOL_VERSION, type: 'viewer:ready' }, window.location.origin)
}

function requestParentAuthOnce(): Promise<{ token: string; username: string }> {
  announceViewerReady()

  return new Promise<{ token: string; username: string }>((resolve, reject) => {
    let timer: number | undefined

    const cleanup = () => {
      window.removeEventListener('message', handleMessage)
      if (timer !== undefined) window.clearTimeout(timer)
    }

    const handleMessage = (event: MessageEvent) => {
      // Only accept the auth reply from this site, sent by the embedding app.
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      const data = event.data
      if (!data || typeof data !== 'object') return

      const isV1 = data.v === PROTOCOL_VERSION && data.type === 'viewer:auth'
      const isLegacy = data.type === undefined
      if (!isV1 && !isLegacy) return
      if (typeof data.accessToken !== 'string' || typeof data.username !== 'string') return

      cleanup()
      resolve({ token: data.accessToken, username: data.username })
    }

    window.addEventListener('message', handleMessage)
    timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for the FASTrack parent to supply an auth token.'))
    }, AUTH_TIMEOUT_MS)

    window.parent.postMessage(
      { v: PROTOCOL_VERSION, type: 'viewer:auth-request' },
      window.location.origin
    )
  })
}

export function requestParentAuth(): Promise<{ token: string; username: string }> {
  if (!authPromise) {
    authPromise = requestParentAuthOnce().catch((error) => {
      // Allow a retry after a timeout or a transient parent failure.
      authPromise = null
      throw error
    })
  }
  return authPromise
}
