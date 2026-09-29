import { useCallback, useEffect, useRef, useState } from 'react'
import type { TokenizerBank } from '@fingerpoint/shared/tokenizer-bank'
import type { TokenizerRun } from '@fingerpoint/shared/tokenizer-probe'
import type { ApiConfig, CodedError } from '@fingerpoint/shared/types'
import * as client from '@/lib/client'

export type TokenizerPhase = 'idle' | 'loading' | 'probing' | 'result'
export interface TokenizerSession {
  phase: TokenizerPhase
  bank: TokenizerBank | null
  run: TokenizerRun | null
  /** Configuration frozen at the start of the run, so edits during review do not change the result. */
  config: ApiConfig | null
  startedAt: number
  /** Failure before any request, such as an invalid address or a missing bank. */
  error: CodedError | null
}

const idle: TokenizerSession = { phase: 'idle', bank: null, run: null, config: null, startedAt: 0, error: null }

/**
 * Runs one tokenizer probe at a time. Stopping aborts the requests in flight but keeps the run, which then
 * settles with the answered probes; starting over or resetting discards it.
 */
export function useTokenizerProbe(active: boolean) {
  const [session, setSession] = useState<TokenizerSession>(idle)
  const controller = useRef<AbortController | null>(null)

  const stop = useCallback(() => controller.current?.abort(), [])

  const discard = useCallback(() => {
    const previous = controller.current
    controller.current = null
    previous?.abort()
  }, [])

  const reset = useCallback(() => {
    discard()
    setSession(idle)
  }, [discard])

  /** Resolves with the settled run, or null when the run was discarded or failed before any request. */
  const start = useCallback(async (config: ApiConfig, route: client.Route): Promise<TokenizerRun | null> => {
    discard()
    const run = new AbortController()
    controller.current = run
    const current = () => controller.current === run
    const frozen = { ...config }
    const startedAt = Date.now()
    setSession({ ...idle, phase: 'loading', config: frozen, startedAt })
    try {
      const bank = await client.loadTokenizerBank()
      if (!current()) return null
      setSession(previous => ({ ...previous, phase: 'probing', bank }))
      const result = await client.probeTokenizer(frozen, bank, route, run.signal, update => {
        if (current()) setSession(previous => ({ ...previous, run: update }))
      })
      if (!current()) return null
      setSession(previous => ({ ...previous, phase: 'result', run: result }))
      return result
    } catch (error) {
      if (current()) setSession(previous => ({ ...previous, phase: 'result', error: error as CodedError }))
      return null
    } finally {
      if (current()) controller.current = null
    }
  }, [discard])

  useEffect(() => { if (!active) stop() }, [active, stop])
  useEffect(() => discard, [discard])

  return { session, start, stop, reset, busy: session.phase === 'loading' || session.phase === 'probing' }
}
