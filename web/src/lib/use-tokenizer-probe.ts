import { useCallback, useEffect, useRef, useState } from 'react'
import { coded } from '@fingerpoint/shared/detection'
import type { TokenizerBank } from '@fingerpoint/shared/tokenizer-bank'
import type { TokenizerRun } from '@fingerpoint/shared/tokenizer-probe'
import type { ApiConfig, CodedError } from '@fingerpoint/shared/types'
import * as client from '@/lib/client'
import type { WebApiConfig } from '@/lib/config'

export type TokenizerPhase = 'idle' | 'loading' | 'probing' | 'result'
export interface TokenizerSession {
  phase: TokenizerPhase
  bank: TokenizerBank | null
  run: TokenizerRun | null
  /** Configuration frozen at the start of the run, so edits during review do not change the result. */
  config: WebApiConfig | null
  startedAt: number
  /** When the run settled, failed or stopped; 0 while it runs. */
  finishedAt: number
  /** Failure before any request, such as an invalid address or a missing bank. */
  error: CodedError | null
}

const probeSignature = (config: ApiConfig) => [config.format, config.baseUrl.trim(), config.model.trim(), config.apiKey, config.stream ?? true].join('\n')
const idle: TokenizerSession = { phase: 'idle', bank: null, run: null, config: null, startedAt: 0, finishedAt: 0, error: null }

/** The latest probe. */
interface Probe {
  controller: AbortController
  /** Endpoint, protocol, model, key and streaming of the run. */
  signature: string
  /** Whether a new probe with the same signature would add nothing. */
  reusable: boolean
}

/**
 * Runs one tokenizer probe at a time next to the sampling requests. Stopping aborts the requests in flight but keeps
 * the run, which then settles with the answered probes; starting over or resetting discards it.
 */
export function useTokenizerProbe() {
  const [session, setSession] = useState<TokenizerSession>(idle)
  const probe = useRef<Probe | null>(null)

  const stop = useCallback(() => probe.current?.controller.abort(), [])

  const discard = useCallback(() => {
    probe.current?.controller.abort()
    probe.current = null
  }, [])

  const reset = useCallback(() => {
    discard()
    setSession(idle)
  }, [discard])

  /** Starts a probe over the route the sampling requests use. It runs on its own; nothing waits for it to settle. */
  const start = useCallback((config: WebApiConfig, route: client.Route) => {
    discard()
    const controller = new AbortController()
    const frozen = { ...config }
    const entry: Probe = { controller, signature: probeSignature(frozen), reusable: true }
    probe.current = entry
    const update = (changes: Partial<TokenizerSession>) => { if (probe.current === entry) setSession(previous => ({ ...previous, ...changes })) }
    setSession({ ...idle, phase: 'loading', config: frozen, startedAt: Date.now() })
    void (async () => {
      let bank: TokenizerBank | null = null
      try {
        bank = await client.loadTokenizerBank()
        let run: TokenizerRun
        if (controller.signal.aborted) {
          // Stopped while the bank loaded: settle as stopped without sending a request.
          run = { steps: [], observations: [], posterior: null, verdict: null, baselineDrift: false, error: coded('The request was cancelled.', 'aborted') }
        } else {
          update({ phase: 'probing', bank })
          run = await client.probeTokenizer(frozen, bank, route, controller.signal, next => update({ run: next }))
        }
        update({ phase: 'result', bank, run, finishedAt: Date.now() })
        // An upstream without usage will not report it on the next attempt either.
        entry.reusable = Boolean(run.posterior?.answered) || run.error?.code === 'no_usage'
      } catch (error) {
        update({ phase: 'result', error: error as CodedError, finishedAt: Date.now() })
        entry.reusable = false
      }
    })()
  }, [discard])

  /** Whether sampling with this configuration should start a probe: none ran for it, or the last one ended without evidence. */
  const needed = useCallback((config: ApiConfig) =>
    probe.current?.signature !== probeSignature(config) || !probe.current.reusable, [])

  useEffect(() => discard, [discard])

  return { session, start, stop, reset, needed, busy: session.phase === 'loading' || session.phase === 'probing' }
}
