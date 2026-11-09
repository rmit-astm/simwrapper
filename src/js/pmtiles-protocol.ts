// Registers the PMTiles protocol once for the whole app. Multiple vector-map
// panels share the same protocol instance.
//
// The FASTrack Viewer serves scenario files through a CloudFront endpoint that
// expects the Cognito access token as a Bearer header (see HTTPFileSystem's AWS
// mode). The stock PMTiles protocol uses plain fetch(), so we register each
// archive with a FetchSource that shares a mutable Headers object and refresh
// the token through the parent app. Standalone/public archives (no parent, or
// no auth reply) simply fetch without the header, exactly as before.
import maplibregl from 'maplibre-gl'
import { FetchSource, PMTiles, Protocol } from 'pmtiles'

import { getAuthTokenAndUsername } from '@/fileSystemConfig'

let protocol: Protocol | null = null
const authHeaders = new Headers()
let tokenFetchedAt = 0
let tokenPromise: Promise<void> | null = null
const TOKEN_TTL_MS = 10 * 60 * 1000
const AUTH_TIMEOUT_MS = 3000

async function refreshToken(force = false): Promise<void> {
  if (!force && Date.now() - tokenFetchedAt < TOKEN_TTL_MS) return
  if (tokenPromise) return tokenPromise
  // Standalone page: there is no parent to supply a token.
  if (typeof window === 'undefined' || window.parent === window) return

  tokenPromise = (async () => {
    try {
      const result = await Promise.race([
        getAuthTokenAndUsername(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('auth timeout')), AUTH_TIMEOUT_MS)
        ),
      ])
      if (result.token) {
        authHeaders.set('Authorization', `Bearer ${result.token}`)
        tokenFetchedAt = Date.now()
      }
    } catch {
      // No auth available: assume a public archive.
    } finally {
      tokenPromise = null
    }
  })()
  return tokenPromise
}

export function ensurePmtilesProtocol(): void {
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }
  void refreshToken()
}

/**
 * Register an archive (with the current auth header) before MapLibre asks for
 * it. Safe to call repeatedly for the same URL.
 */
export async function registerPmtilesUrl(url: string): Promise<void> {
  ensurePmtilesProtocol()
  await refreshToken()
  if (!protocol || protocol.get(url)) return
  protocol.add(new PMTiles(new FetchSource(url, authHeaders)))
}

/** Register the urgent refresh path used by the Viewer's refresh button. */
export async function refreshPmtilesAuth(): Promise<void> {
  await refreshToken(true)
}

// Exposed for diagnostics/tests; not used by the panels.
export function pmtilesProtocol(): Protocol | null {
  return protocol
}
