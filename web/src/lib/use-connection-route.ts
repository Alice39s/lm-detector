import { useCallback, useEffect, useRef, useState } from 'react'
import { endpoint } from '@fingerpoint/shared/detection'
import type { ApiConfig } from '@fingerpoint/shared/types'
import type { Route } from '@/lib/client'
import { grantProxyConsent, hasProxyConsent, proxyEndpoint, sniffReachability, upstreamOrigin, type Reachability } from '@/lib/route'

export type ProxyConsentAnswer = 'once' | 'always' | null
export interface ProxyConsentRequest { origin: string; proxy: string; reachability: Exclude<Reachability, 'direct'> }

/**
 * Decides the route for one run: direct when the endpoint allows browser CORS, otherwise the configured proxy after
 * the user agrees for this proxy and origin. Resolves null when the user dismisses the consent dialog, and rejects
 * with `proxy_missing` when Worker mode has no valid address; nothing is sent in either case.
 */
export function useConnectionRoute() {
  const [request, setRequest] = useState<ProxyConsentRequest | null>(null)
  const [checking, setChecking] = useState(false)
  const pending = useRef<((answer: ProxyConsentAnswer) => void) | null>(null)

  const answer = useCallback((value: ProxyConsentAnswer) => {
    const settle = pending.current
    pending.current = null
    setRequest(null)
    settle?.(value)
  }, [])

  const resolve = useCallback(async (config: ApiConfig): Promise<Route | null> => {
    const url = endpoint(config)
    setChecking(true)
    let reachability: Reachability
    try { reachability = await sniffReachability(url, config.format) } finally { setChecking(false) }
    if (reachability === 'direct') return { kind: 'direct' }
    const origin = upstreamOrigin(url), proxy = proxyEndpoint()
    if (!proxy) throw Object.assign(new Error('Worker mode has no valid Worker address.'), { code: 'proxy_missing' as const })
    if (hasProxyConsent(proxy, origin)) return { kind: 'proxy', endpoint: proxy }
    const choice = await new Promise<ProxyConsentAnswer>(settle => {
      pending.current?.(null)
      pending.current = settle
      setRequest({ origin, proxy, reachability })
    })
    if (!choice) return null
    grantProxyConsent(proxy, origin, choice === 'always')
    return { kind: 'proxy', endpoint: proxy }
  }, [])

  // Leaving the page while the dialog is open counts as dismissing it.
  useEffect(() => () => pending.current?.(null), [])

  return { resolve, checking, request, answer }
}
