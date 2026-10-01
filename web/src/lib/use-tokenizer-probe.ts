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
  /** Endpoint, protocol, model and key of the run; samples drawn with another signature are not fused with it. */
  signature: string
  startedAt: number
  /** Failure before any request, such as an invalid address or a missing bank. */
  error: CodedError | null
}
/** A finished probe as the detection reads it, independent of later renders. */
export interface SettledProbe { bank: TokenizerBank | null; run: TokenizerRun | null; signature: string; startedAt: number; model: string; error: CodedError | null }

export const probeSignature = (config: ApiConfig) => [config.format, config.baseUrl.trim(), config.model.trim(), config.apiKey].join('\n')
const idle: TokenizerSession = { phase: 'idle', bank: null, run: null, config: null, signature: '', startedAt: 0, error: null }

/**
 * Runs one tokenizer probe at a time next to the sampling requests. Stopping aborts the requests in flight but keeps
 * the run, which then settles with the answered probes; starting over or resetting discards it.
 */
export function useTokenizerProbe(active: boolean) {
  const [session, setSession] = useState<TokenizerSession>(idle)
  const controller = useRef<AbortController | null>(null)
  const pending = useRef<Promise<SettledProbe> | null>(null)
  /** Signature of the latest probe and whether a new one would add anything, read outside the render cycle. */
  const latest = useRef<{ signature: string; reusable: boolean } | null>(null)

  const stop = useCallback(() => controller.current?.abort(), [])

  const discard = useCallback(() => {
    const previous = controller.current
    controller.current = null
    pending.current = null
    latest.current = null
    previous?.abort()
  }, [])

  const reset = useCallback(() => {
    discard()
    setSession(idle)
  }, [discard])

  const start = useCallback((config: ApiConfig) => {
    discard()
    const run = new AbortController()
    controller.current = run
    const current = () => controller.current === run
    const frozen = { ...config }
    const signature = probeSignature(frozen)
    const startedAt = Date.now()
    const base = { signature, startedAt, model: frozen.model.trim() }
    setSession({ ...idle, phase: 'loading', config: frozen, signature, startedAt })
    latest.current = { signature, reusable: true }
    const settled = (async (): Promise<SettledProbe> => {
      let bank: TokenizerBank | null = null
      try {
        bank = await client.loadTokenizerBank()
        if (current()) setSession(previous => ({ ...previous, phase: 'probing', bank }))
        const result = await client.probeTokenizer(frozen, bank, run.signal, update => {
          if (current()) setSession(previous => ({ ...previous, run: update }))
        })
        if (current()) {
          setSession(previous => ({ ...previous, phase: 'result', run: result }))
          // An upstream without usage will not report it on the next attempt either.
          latest.current = { signature, reusable: Boolean(result.posterior?.answered) || result.error?.code === 'no_usage' }
        }
        return { ...base, bank, run: result, error: result.error ?? null }
      } catch (error) {
        if (current()) {
          setSession(previous => ({ ...previous, phase: 'result', error: error as CodedError }))
          latest.current = { signature, reusable: false }
        }
        return { ...base, bank, run: null, error: error as CodedError }
      } finally {
        if (current()) controller.current = null
      }
    })()
    pending.current = settled
    return settled
  }, [discard])

  /** The settled run of the current probe, or null when none was started or it was discarded. */
  const settled = useCallback(() => pending.current ?? Promise.resolve(null), [])

  /** Whether sampling with this configuration should start a probe: none ran for it, or the last one ended without evidence. */
  const needed = useCallback((config: ApiConfig) =>
    latest.current?.signature !== probeSignature(config) || !latest.current.reusable, [])

  useEffect(() => { if (!active) stop() }, [active, stop])
  useEffect(() => discard, [discard])

  return { session, start, stop, reset, settled, needed, busy: session.phase === 'loading' || session.phase === 'probing' }
}
