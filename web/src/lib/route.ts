import type { ApiConfig } from '@fingerpoint/shared/types'

/**
 * How the browser reaches an API endpoint:
 * - direct: the endpoint answers cross-origin requests with the same method and header names (CORS);
 * - blocked: the host is reachable, but the browser refused the response, so only the proxy can call it;
 * - unreachable: the browser could not reach the host at all (DNS, TLS, mixed content, CORS preflight errors that
 *   also fail no-cors, or a timeout).
 */
export type Reachability = 'direct' | 'blocked' | 'unreachable'

const SNIFF_TIMEOUT_MS = 8000
/** Verdicts expire so that a server that enables CORS later is noticed. */
const SNIFF_TTL_MS = 10 * 60_000
const SNIFF_KEY = 'fingerpoint-cors-v1'
const CONSENT_KEY = 'fingerpoint-proxy-consent-v1'
/** A dummy credential with the real header names: preflights carry names only, and a 401 without a model run is the expected answer. */
const PROBE_KEY = 'sk-cors-probe'

type Format = ApiConfig['format']

/** Headers of a direct request. The sniff and the real call share this function, so their header names always match. */
export function directHeaders(format: Format, apiKey: string, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' }
  if (format === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
    // Anthropic answers browser requests only when the client opts in with this header.
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  } else headers.Authorization = `Bearer ${apiKey}`
  return headers
}

/** Fetch options shared by the sniff and direct calls. `redirect: 'error'` keeps x-api-key from following a redirect. */
export const directInit: RequestInit = { mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' }

const memory = new Map<string, { reachability: Reachability; at: number }>()
const sniffKey = (url: string, format: Format) => `${format} ${url}`

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch { return null }
}
function writeJson(storage: Storage, key: string, value: unknown) {
  try { storage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable: the verdict stays in memory */ }
}

function cached(url: string, format: Format): Reachability | null {
  const key = sniffKey(url, format)
  const entry = memory.get(key) ?? readJson<Record<string, { reachability: Reachability; at: number }>>(sessionStorage, SNIFF_KEY)?.[key]
  return entry && Date.now() - entry.at < SNIFF_TTL_MS ? entry.reachability : null
}

function remember(url: string, format: Format, reachability: Reachability) {
  const key = sniffKey(url, format), entry = { reachability, at: Date.now() }
  memory.set(key, entry)
  writeJson(sessionStorage, SNIFF_KEY, { ...readJson<Record<string, unknown>>(sessionStorage, SNIFF_KEY), [key]: entry })
  notify()
}

/** Drops the verdict for an endpoint, for example after a direct request failed at the network level. */
export function forgetReachability(url: string, format: Format) {
  const key = sniffKey(url, format)
  memory.delete(key)
  const stored = readJson<Record<string, unknown>>(sessionStorage, SNIFF_KEY)
  if (stored && key in stored) { delete stored[key]; writeJson(sessionStorage, SNIFF_KEY, stored) }
  notify()
}

/**
 * Sends the real request shape (same URL, method and header names) with a dummy key and an empty JSON body, so the
 * server rejects it before running a model. Any readable HTTP status means direct calls work. A failure is then told
 * apart from an unreachable host with a no-cors GET, which resolves opaquely whenever any HTTP response arrives.
 */
export async function sniffReachability(url: string, format: Format): Promise<Reachability> {
  const known = cached(url, format)
  if (known) return known
  let reachability: Reachability
  try {
    await fetch(url, { ...directInit, method: 'POST', headers: directHeaders(format, PROBE_KEY, false), body: '{}', signal: AbortSignal.timeout(SNIFF_TIMEOUT_MS) })
    reachability = 'direct'
  } catch {
    try {
      const response = await fetch(url, { method: 'GET', mode: 'no-cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(SNIFF_TIMEOUT_MS) })
      reachability = response.type === 'opaque' ? 'blocked' : 'unreachable'
    } catch { reachability = 'unreachable' }
  }
  remember(url, format, reachability)
  return reachability
}

export const upstreamOrigin = (url: string) => new URL(url).origin

/** Proxy consent per upstream origin: "once" lasts for this page session, "always" is kept in localStorage. */
const sessionConsent = new Set<string>()
type ConsentRecord = Record<string, { at: number }>

export function hasProxyConsent(origin: string) {
  return sessionConsent.has(origin) || Boolean(readJson<ConsentRecord>(localStorage, CONSENT_KEY)?.[origin])
}
export function isConsentRemembered(origin: string) {
  return Boolean(readJson<ConsentRecord>(localStorage, CONSENT_KEY)?.[origin])
}
export function grantProxyConsent(origin: string, remember: boolean) {
  sessionConsent.add(origin)
  if (remember) writeJson(localStorage, CONSENT_KEY, { ...readJson<ConsentRecord>(localStorage, CONSENT_KEY), [origin]: { at: Date.now() } })
  notify()
}
export function revokeProxyConsent(origin: string) {
  sessionConsent.delete(origin)
  const stored = readJson<ConsentRecord>(localStorage, CONSENT_KEY)
  if (stored?.[origin]) { delete stored[origin]; writeJson(localStorage, CONSENT_KEY, stored) }
  notify()
}

/** Subscribers re-render when a verdict or a consent changes, including consent changes from other tabs. */
const listeners = new Set<() => void>()
let version = 0
function notify() { version++; listeners.forEach(listener => listener()) }
export function subscribeRoute(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => { if (event.key === CONSENT_KEY) notify() }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}
export const routeVersion = () => version
export const knownReachability = (url: string, format: Format) => cached(url, format)
