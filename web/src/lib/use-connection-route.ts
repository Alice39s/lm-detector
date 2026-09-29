import { useCallback, useEffect, useRef, useState } from 'react'
import { endpoint } from '@fingerpoint/shared/detection'
import type { ApiConfig } from '@fingerpoint/shared/types'
import type { Route } from '@/lib/client'
import { grantProxyConsent, hasProxyConsent, sniffReachability, upstreamOrigin, type Reachability } from '@/lib/route'

export type ProxyConsentAnswer = 'once' | 'always' | null
export interface ProxyConsentRequest { origin: string; reachability: Exclude<Reachability, 'direct'> }

/**
 * Decides the route for one run: direct when the endpoint allows browser CORS, otherwise the proxy after the user
 * agrees for this origin. Resolves null when the user dismisses the consent dialog; nothing is sent in that case.
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
    if (reachability === 'direct') return 'direct'
    const origin = upstreamOrigin(url)
    if (hasProxyConsent(origin)) return 'proxy'
    const choice = await new Promise<ProxyConsentAnswer>(settle => {
      pending.current?.(null)
      pending.current = settle
      setRequest({ origin, reachability })
    })
    if (!choice) return null
    grantProxyConsent(origin, choice === 'always')
    return 'proxy'
  }, [])

  // Leaving the page while the dialog is open counts as dismissing it.
  useEffect(() => () => pending.current?.(null), [])

  return { resolve, checking, request, answer }
}
