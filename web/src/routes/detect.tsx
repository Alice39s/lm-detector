import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, Copy, Loader2, MoreVertical, Star, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ApiConfigPanel } from '@/components/api-config-panel'
import { PixelShader, PixelSpinner } from '@/components/pixel-shader'
import { Segmented } from '@/components/segmented'
import { useLoadedBank } from '@/lib/bank-context'
import { ResultPanel, type ResultEvidence } from '@/components/result-panel'
import { SampleCard, SampleStrip, isBusyState, type Mode, type SampleUI } from '@/components/sample-card'
import { TokenizerCard, TokenizerDetails, TokenizerStripButton } from '@/components/tokenizer-panel'
import { ProxyConsentDialog } from '@/components/proxy-consent-dialog'
import { useI18n } from '@/i18n'
import * as client from '@/lib/client'
import { configComplete, useApiConfig, type WebApiConfig } from '@/lib/config'
import { describeError } from '@/lib/errors'
import { exportResultImage } from '@/lib/export-image'
import { useMotionPreset } from '@/lib/motion'
import { useModelMatchCelebration } from '@/lib/use-model-match-celebration'
import { probeSignature, useTokenizerProbe, type SettledProbe } from '@/lib/use-tokenizer-probe'
import { useConnectionRoute } from '@/lib/use-connection-route'
import { forgetReachability } from '@/lib/route'
import { cn } from '@/lib/utils'
import { endpoint } from '@fingerpoint/shared/detection'
import type { Analysis, Challenge, CodedError, CollectionProgress } from '@fingerpoint/shared/types'
import { redactPrivateMetadata } from '@fingerpoint/shared/privacy'
import { anomalousSamples } from '@fingerpoint/shared/sample-distribution'

type Phase = 'edit' | 'sampling' | 'computing' | 'result'
/** A sample index, or the tokenizer probe in the fourth slot of the sample strip. */
type Expanded = number | 'tokenizer' | null
const idle = (): SampleUI => ({ text: '', state: 'idle' })
const cliCommand = 'bunx lmfpd@latest --help'

function safeError(message: string | undefined, key: string): string | undefined {
  if (!message) return undefined
  const redacted = key ? message.replaceAll(key, '[REDACTED]') : message
  return redactPrivateMetadata(redacted
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[\w-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]'))
}

export default function DetectRoute() {
  const bank = useLoadedBank()
  const i18n = useI18n()
  const { t } = i18n
  const { snappy, reduced } = useMotionPreset()
  const active = useLocation().pathname === '/'
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>(() => params.get('mode') === 'api' ? 'api' : 'manual')
  useEffect(() => {
    if (active && (params.get('mode') === 'api') !== (mode === 'api')) {
      setParams(mode === 'api' ? { mode: 'api' } : {}, { replace: true })
    }
  }, [active, mode, params, setParams])
  const tokenizer = useTokenizerProbe(active)
  const connection = useConnectionRoute()

  const [challenges, setChallenges] = useState<Challenge[]>(() => client.generateChallenges(3))
  const [samples, setSamples] = useState<SampleUI[]>(() => [idle(), idle(), idle()])
  const [computing, setComputing] = useState(false)
  const [result, setResult] = useState<Analysis | null>(null)
  const [resultModel, setResultModel] = useState<string | null>(null)
  const [resultEvidence, setResultEvidence] = useState<ResultEvidence | null>(null)
  const [expanded, setExpanded] = useState<Expanded>(null)
  /** Verification is waiting for the probe to settle before it fuses the result. */
  const [awaitingProbe, setAwaitingProbe] = useState(false)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [config, update, profileManager] = useApiConfig(() => toast.error(t('errors.unknown')))
  const previousProfileId = useRef(profileManager.activeId)
  const [apiConfigOpen, setApiConfigOpen] = useState(() => !configComplete(config))
  const apiConfigRef = useRef<HTMLDivElement>(null)
  /** One controller per running sample, so each card starts and stops on its own. */
  const runs = useRef(new Map<number, AbortController>())
  const verifying = useRef<object | null>(null)
  const mounted = useRef(true)
  const samplesRef = useRef(samples)
  const challengesRef = useRef(challenges)
  const sampledConfigs = useRef<(WebApiConfig | undefined)[]>([])
  /** The number-only analysis of the current result and the probe signature it may be fused with. */
  const fingerprint = useRef<{ analysis: Analysis; signature: string | null } | null>(null)
  useLayoutEffect(() => {
    if (previousProfileId.current === profileManager.activeId) return
    previousProfileId.current = profileManager.activeId
    restart()
  }, [profileManager.activeId])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of runs.current.values()) controller.abort()
      runs.current.clear()
    }
  }, [])

  const filled = samples.filter(s => s.text.trim()).length
  const sampling = samples.some(sample => isBusyState(sample.state))
  const phase: Phase = computing ? 'computing' : sampling ? 'sampling' : result ? 'result' : 'edit'
  /** Checking the endpoint or waiting for proxy consent holds back every new request. */
  const connecting = connection.checking || connection.request !== null
  const locked = sampling || computing || connecting
  const canSample = configComplete(config) && !computing && !connecting
  const probeShown = mode === 'api' && tokenizer.session.phase !== 'idle'
  useModelMatchCelebration(result, resultModel, active && mode === 'api' && phase === 'result')

  function replaceSamples(next: SampleUI[]) {
    samplesRef.current = next
    setSamples(next)
  }

  function replaceChallenges(next: Challenge[]) {
    challengesRef.current = next
    setChallenges(next)
  }

  function patch(index: number, changes: Partial<SampleUI>) {
    replaceSamples(samplesRef.current.map((sample, i) => i === index ? { ...sample, ...changes } : sample))
  }

  function clearResult() {
    fingerprint.current = null
    setResult(null)
    setResultEvidence(null)
  }

  /** Fuses a settled probe into the number-only analysis when it measured the configuration the samples came from. */
  function showResult(analysis: Analysis, signature: string | null, probe: SettledProbe | null) {
    const matching = probe && probe.signature === signature ? probe : null
    // A baseline without any answered probe carries no evidence; the result then says why.
    const evidence = matching?.run?.posterior?.answered && matching.bank
      ? { run: matching.run, bank: matching.bank, startedAt: matching.startedAt, model: matching.model } : null
    const fused = evidence ? client.fuseTokenizer(analysis, evidence) : analysis
    fingerprint.current = { analysis, signature }
    setResult(fused)
    setResultEvidence(matching ? { probe: evidence, error: evidence ? null : matching.error, model: matching.model } : null)
  }

  /**
   * Stops the given samples, or all of them; other samples keep running.
   * Stopping all of them also stops the tokenizer probe, which serves every sample.
   */
  function stop(indexes?: number[]) {
    if (!indexes) tokenizer.stop()
    const stopped = (indexes ?? [...runs.current.keys()]).filter(i => runs.current.has(i))
    if (!stopped.length) return
    for (const i of stopped) {
      runs.current.get(i)!.abort()
      runs.current.delete(i)
    }
    replaceSamples(samplesRef.current.map((sample, i) => stopped.includes(i) && isBusyState(sample.state)
      ? { ...sample, state: 'stopped', draftText: sample.text.trim() ? undefined : sample.draftText, errorCode: undefined, errorText: undefined }
      : sample))
  }

  useEffect(() => {
    if (!active) {
      stop()
      setErrorDetail(null)
    }
  }, [active])

  /** Opens the API configuration and focuses the first missing field. Returns whether the configuration is usable. */
  function requireConfig(requestConfig: WebApiConfig) {
    if (configComplete(requestConfig)) return true
    setApiConfigOpen(true)
    requestAnimationFrame(() => {
      const inputs = apiConfigRef.current?.querySelectorAll<HTMLInputElement>('[data-api-required]')
      Array.from(inputs ?? []).find(input => !input.value.trim())?.focus()
    })
    toast.error(t('api.incomplete'))
    return false
  }

  /** Sniffs CORS for the endpoint and asks for proxy consent when needed. Returns null when nothing may be sent. */
  async function resolveRoute(requestConfig: WebApiConfig): Promise<client.Route | null> {
    try {
      return await connection.resolve(requestConfig)
    } catch (error) {
      toast.error(describeError(i18n, error))
      if ((error as CodedError).code === 'proxy_missing') {
        setApiConfigOpen(true)
        requestAnimationFrame(() => apiConfigRef.current?.querySelector<HTMLInputElement>('#proxy-worker-url')?.focus())
      }
      return null
    }
  }

  /** A direct request that failed at the network level re-sniffs the endpoint next time. */
  function recheckAfter(route: client.Route, requestConfig: WebApiConfig, failed: boolean) {
    if (route.kind === 'direct' && failed) forgetReachability(endpoint(requestConfig), requestConfig.format)
  }

  /** Probes over the route the samples use; a network failure on a direct route re-sniffs the endpoint next time. */
  function startProbe(requestConfig: WebApiConfig, route: client.Route) {
    const settled = tokenizer.start(requestConfig, route)
    void settled.then(probe => recheckAfter(route, requestConfig, probe.error?.code === 'network'))
    return settled
  }

  async function sampleIndexes(requested: number[], requestConfig: WebApiConfig = config) {
    const indexes = requested.filter(i => !runs.current.has(i))
    if (!indexes.length || verifying.current || !mounted.current || connection.checking) return
    if (!requireConfig(requestConfig)) return
    const route = await resolveRoute(requestConfig)
    if (!route || verifying.current || !mounted.current || indexes.some(i => runs.current.has(i))) return
    const frozenConfig = { ...requestConfig, parallel: indexes.length > 1 && (requestConfig.parallel ?? false) }
    const controllers = new Map(indexes.map(i => [i, new AbortController()]))
    for (const [i, controller] of controllers) runs.current.set(i, controller)
    // The probe measures the upstream itself, so one probe serves every sample drawn with this configuration.
    if (requestConfig.tokenizerProbe && tokenizer.needed(requestConfig)) void startProbe(requestConfig, route)
    replaceSamples(samplesRef.current.map((sample, i) => indexes.includes(i)
      ? { ...sample, draftText: '', state: 'pending', errorCode: undefined, httpStatus: undefined, errorText: undefined, elapsedMs: undefined, throughput: undefined }
      : sample))

    const accepted: boolean[] = []
    if (frozenConfig.parallel) accepted.push(...await Promise.all(indexes.map(i => sampleOne(i, frozenConfig, controllers.get(i)!, route))))
    else for (const i of indexes) accepted.push(await sampleOne(i, frozenConfig, controllers.get(i)!, route))
    if (frozenConfig.autoVerify && accepted.every(Boolean) && samplesRef.current.every(sample => sample.text.trim())) {
      void verify()
    }
  }

  async function sampleOne(index: number, requestConfig: WebApiConfig, controller: AbortController, route: client.Route): Promise<boolean> {
    const current = () => mounted.current && runs.current.get(index) === controller
    if (!current()) return false
    let accepted = false
    let startedAt: number | undefined

    function applyProgress(progress: CollectionProgress) {
      const challenge = progress.challenges?.[0]
      if (!current() || !challenge || accepted) return
      const state = challenge.state ?? 'pending'
      if (state === 'requesting' && startedAt === undefined) startedAt = performance.now()
      const finished = state === 'done' || state === 'capped' || state === 'rejected'
      const elapsedMs = finished && startedAt !== undefined ? performance.now() - startedAt : undefined
      if ((state === 'done' || state === 'capped') && challenge.text.trim()) {
        accepted = true
        sampledConfigs.current[index] = requestConfig
        patch(index, { text: challenge.text, draftText: undefined, state, elapsedMs, throughput: challenge.throughput, errorCode: undefined, httpStatus: undefined, errorText: undefined })
        clearResult()
      } else {
        const previous = samplesRef.current[index]
        patch(index, {
          draftText: state === 'rejected' && previous.text.trim() ? undefined : challenge.text,
          state, elapsedMs, throughput: challenge.throughput,
          errorCode: state === 'rejected' ? challenge.errorCode : undefined,
          httpStatus: state === 'rejected' ? challenge.httpStatus : undefined,
          errorText: state === 'rejected' ? safeError(challenge.error, requestConfig.apiKey) : undefined,
        })
      }
    }

    try {
      await client.testApi(requestConfig, [challengesRef.current[index]], applyProgress, route, controller.signal)
    } catch (error) {
      if (!current()) return false
      const coded = error as CodedError
      const sample = samplesRef.current[index]
      if (isBusyState(sample.state)) patch(index, { state: 'rejected', draftText: sample.text.trim() ? undefined : sample.draftText, errorCode: coded?.code, httpStatus: coded?.httpStatus, errorText: safeError(error instanceof Error ? error.message : undefined, requestConfig.apiKey) })
    }
    recheckAfter(route, requestConfig, samplesRef.current[index].errorCode === 'network')
    if (current()) runs.current.delete(index)
    return accepted
  }

  async function verify() {
    if (verifying.current || runs.current.size || !mounted.current || !samplesRef.current.some(sample => sample.text.trim())) return
    const token = {}
    verifying.current = token
    const outputs = samplesRef.current.map((sample, i) => ({ text: sample.text, expected_count: challengesRef.current[i].expected_count }))
    // Only replies the API returned unedited take the evidence, and only from a probe of the configuration that produced
    // them. An edited reply is idle again; a failed replacement keeps the earlier API reply and its configuration.
    const signatures = new Set(samplesRef.current.flatMap((sample, i) => {
      if (!sample.text.trim()) return []
      const sampled = sampledConfigs.current[i]
      return [sampled?.tokenizerProbe && sample.state !== 'idle' ? probeSignature(sampled) : null]
    }))
    const signature = mode === 'api' && signatures.size === 1 ? [...signatures][0] : null
    setComputing(true)
    setExpanded(null)
    try {
      const waiting = signature ? tokenizer.settled() : null
      setAwaitingProbe(Boolean(waiting))
      const [analysis, probe] = await Promise.all([client.analyze(outputs, bank), waiting])
      if (!mounted.current || verifying.current !== token) return
      setResultModel(mode === 'api' ? config.model : null)
      showResult(analysis, signature, probe)
    } catch (error) {
      if (!mounted.current || verifying.current !== token) return
      toast.error(describeError(i18n, error, 'errors.analyze'))
    } finally {
      if (mounted.current) setAwaitingProbe(false)
      if (verifying.current === token) {
        verifying.current = null
        setComputing(false)
      }
    }
  }

  /** Probes again with the sampling configuration; a result on screen takes the new evidence without resampling. */
  async function retryProbe() {
    const requestConfig = sampledConfigs.current.find(Boolean) ?? config
    if (locked || tokenizer.busy || !requireConfig(requestConfig)) return
    const shown = fingerprint.current
    const route = await resolveRoute(requestConfig)
    if (!route || !mounted.current) return
    const settled = await startProbe(requestConfig, route)
    // A new sample or a new verification replaces the result while the probe runs; only the same result takes it.
    if (mounted.current && shown && fingerprint.current === shown && !verifying.current) showResult(shown.analysis, shown.signature, settled)
  }

  function restart() {
    stop()
    tokenizer.reset()
    verifying.current = null
    setComputing(false)
    replaceChallenges(client.generateChallenges(3))
    replaceSamples([idle(), idle(), idle()])
    sampledConfigs.current = []
    clearResult()
    setExpanded(null)
  }

  /** Abnormal distributions follow the prompt, so retrying them needs new prompts. */
  function replacePrompts(indexes: number[]) {
    if (verifying.current || indexes.some(i => runs.current.has(i))) return
    const kept = challengesRef.current.filter((_, i) => !indexes.includes(i)).map(challenge => challenge.expected_count)
    const fresh = client.generateChallenges(indexes.length, kept)
    replaceChallenges(challengesRef.current.map((challenge, i) => indexes.includes(i) ? fresh[indexes.indexOf(i)] : challenge))
    replaceSamples(samplesRef.current.map((sample, i) => indexes.includes(i) ? idle() : sample))
    clearResult()
    setExpanded(null)
    if (mode === 'api') void sampleIndexes(indexes, sampledConfigs.current[indexes[0]] ?? config)
  }

  function edit(i: number, text: string) {
    if (runs.current.has(i) || verifying.current) return
    patch(i, { text, draftText: undefined, state: 'idle', errorCode: undefined, httpStatus: undefined, errorText: undefined, elapsedMs: undefined, throughput: undefined })
    clearResult()
  }

  async function saveImage() {
    if (!result) return
    try { await exportResultImage(result, i18n); if (mounted.current) toast.success(t('detect.imageSaved')) }
    catch { if (mounted.current) toast.error(t('detect.imageFailed')) }
  }

  async function copyCliCommand() {
    try {
      await navigator.clipboard.writeText(cliCommand)
      toast.success(t('detect.cliCopied'))
    } catch {
      toast.error(t('detect.cliCopyFailed'))
    }
  }

  const emptyIndexes = samples.map((s, i) => (s.text.trim() ? -1 : i)).filter(i => i >= 0)
  const showStrip = phase === 'computing' || phase === 'result'
  const anomalous = phase === 'result' && result
    ? anomalousSamples(samples.map((sample, i) => result.diagnostics[i]?.accepted ? sample.text : ''))
    : []
  const showProbeError = (detail: string) => setErrorDetail(safeError(detail, tokenizer.session.config?.apiKey ?? config.apiKey) ?? '')

  /** The probe belongs to API mode, so manual mode stops it and closes its details. */
  function changeMode(next: Mode) {
    if (locked || next === mode) return
    if (next === 'manual') {
      tokenizer.stop()
      if (expanded === 'tokenizer') setExpanded(null)
    }
    setMode(next)
  }

  function collapseSample(index: number) {
    setExpanded(null)
    document.getElementById(`sample-trigger-${index}`)?.focus({ preventScroll: true })
  }

  function collapseProbe() {
    setExpanded(null)
    document.getElementById('tokenizer-trigger')?.focus({ preventScroll: true })
  }

  function renderSample(index: number, collapsible = false) {
    return <SampleCard
      key={challenges[index].id}
      index={index}
      challenge={challenges[index]}
      sample={samples[index]}
      mode={mode}
      canSample={canSample}
      locked={computing}
      onChange={text => edit(index, text)}
      onResample={() => sampleIndexes([index], sampledConfigs.current[index] ?? config)}
      onStop={() => stop([index])}
      onShowError={() => setErrorDetail(samples[index].errorText ?? null)}
      onCollapse={collapsible ? () => collapseSample(index) : undefined}
      anomalous={anomalous.includes(index)}
    />
  }

  return (
    <div className={cn('fp-page', 'has-actionbar')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-h1">{t('detect.title')}</h1>
        <Segmented label={t('detect.modeLabel')} value={mode} onChange={changeMode} disabled={locked} options={[{ value: 'manual', label: t('detect.modeManual') }, { value: 'api', label: t('detect.modeApi') }]} />
      </div>

      <aside className="fp-cli-promo relative isolate overflow-hidden" aria-label={t('detect.cliTitle')}>
        <PixelShader effect="rain" className="absolute inset-0 -z-10 text-muted-foreground/30 [mask-image:linear-gradient(90deg,transparent_25%,#000_70%)]" />
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <strong className="shrink-0 font-medium">{t('detect.cliTitle')}</strong>
          <span className="text-muted-foreground">{t('detect.cliDescription')}</span>
        </div>
        <button type="button" className="fp-cli-command" onClick={copyCliCommand} aria-label={t('detect.cliCopy', { command: cliCommand })} title={t('detect.cliCopy', { command: cliCommand })}>
          <code className="fp-mono text-meta"><span>bunx</span> lmfpd@latest <span>--help</span></code>
          <Copy className="size-3.5 shrink-0" aria-hidden="true" />
        </button>
        <a href="https://github.com/Ikaleio/lm-detector#%E6%A3%80%E6%B5%8B-cli" target="_blank" rel="noopener noreferrer" className="fp-cli-link">
          <span className="sm:hidden">{t('detect.cliGuideShort')}</span>
          <span className="hidden sm:inline">{t('detect.cliGuide')}</span>
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a>
      </aside>

      <AnimatePresence initial={false}>
        {mode === 'api' && <motion.div
          key="api-configuration"
          initial={{ height: 0, opacity: 0, marginBottom: -24 }}
          animate={{ height: 'auto', opacity: 1, marginBottom: 0 }}
          exit={{ height: 0, opacity: 0, marginBottom: -24 }}
          transition={snappy}
          className="shrink-0 overflow-hidden"
        >
          <ApiConfigPanel containerRef={apiConfigRef} open={apiConfigOpen} onOpenChange={setApiConfigOpen} config={config} update={update} profileManager={profileManager} disabled={locked} />
        </motion.div>}
      </AnimatePresence>

      <section className="flex flex-col gap-4" aria-label={t('detect.samples')}>
        {showStrip && <SampleStrip samples={samples} challenges={challenges} expanded={typeof expanded === 'number' ? expanded : null} anomalous={anomalous}
          onToggle={i => setExpanded(e => (e === i ? null : i))}
          extra={probeShown ? <TokenizerStripButton session={tokenizer.session} expanded={expanded === 'tokenizer'} onToggle={() => setExpanded(e => (e === 'tokenizer' ? null : 'tokenizer'))} /> : undefined} />}
        {showStrip ? (
          <AnimatePresence initial={false}>
            {expanded !== null && <motion.div
              key="sample-details"
              initial={{ height: 0, opacity: 0, marginTop: -16 }}
              animate={{ height: 'auto', opacity: 1, marginTop: 0 }}
              exit={{ height: 0, opacity: 0, marginTop: -16 }}
              transition={reduced ? { duration: 0 } : snappy}
              className="overflow-hidden"
            >
              {expanded === 'tokenizer'
                ? <TokenizerDetails session={tokenizer.session} onShowError={showProbeError} onCollapse={collapseProbe} onRetry={retryProbe} canRetry={!locked && config.tokenizerProbe} />
                : renderSample(expanded, true)}
            </motion.div>}
          </AnimatePresence>
        ) : <>
          <div className="fp-grid-samples">{challenges.map((_, index) => renderSample(index))}</div>
          {probeShown && <TokenizerCard session={tokenizer.session} onShowError={showProbeError} onRetry={() => void retryProbe()} canRetry={!locked && config.tokenizerProbe} />}
        </>}
      </section>

      {phase === 'computing' && (
        <div className="flex h-12 items-center gap-2 text-body text-muted-foreground" role="status">
          <PixelSpinner />
          {awaitingProbe && tokenizer.busy ? t('tokenizer.waiting') : t('detect.computing')}
          <PixelShader effect="scan" cell={3} className="h-6 min-w-0 flex-1 text-muted-foreground/60" />
        </div>
      )}
      {phase === 'result' && result && <ResultPanel result={result} anomalous={anomalous} mode={mode} evidence={resultEvidence} onReplacePrompts={() => replacePrompts(anomalous)} />}

      <div className="fp-detect-footer">
        <a href="https://github.com/Ikaleio/lm-detector" target="_blank" rel="noopener noreferrer" className="fp-star-link">
          <Star className="size-4" aria-hidden="true" />
          {t('detect.starRequest')}
        </a>
        <div className="fp-actionbar">
          {phase === 'result' ? (
            <>
              {result && <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={t('detect.more')} />}><MoreVertical /></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem onClick={() => client.exportAnalysis(result, resultEvidence?.probe ?? undefined)}>{t('detect.exportJson')}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent>
              </DropdownMenu>}
              <Button variant="outline" className="h-9" onClick={saveImage}>{t('detect.saveImage')}</Button>
              <Button className="h-9" onClick={restart}>{t('detect.restart')}</Button>
            </>
          ) : phase === 'sampling' ? (
            <>
              <Button variant="outline" className="h-9" onClick={() => stop()}>{t('detect.stop')}</Button>
              <Button className="h-9" disabled><Loader2 data-icon="inline-start" className="animate-spin" />{t('detect.sampling')}</Button>
            </>
          ) : phase === 'computing' ? (
            <>
              {awaitingProbe && tokenizer.busy && <Button variant="outline" className="h-9" onClick={tokenizer.stop}>{t('tokenizer.stop')}</Button>}
              <Button className="h-9" disabled><PixelSpinner data-icon="inline-start" />{t('detect.computing')}</Button>
            </>
          ) : (
            <>
              {samples.some(s => s.text.trim() || s.draftText?.trim()) && <Button variant="ghost" className="h-9" onClick={restart}>{t('detect.restart')}</Button>}
              {mode === 'api' && emptyIndexes.length > 0 ? (
                <>
                  {filled > 0 && <Button variant="outline" className="h-9" onClick={() => verify()}>{t('detect.verifyPartial', { n: filled })}</Button>}
                  <Button className="h-9" disabled={locked} onClick={() => sampleIndexes(emptyIndexes)}>{connection.checking ? <><Loader2 data-icon="inline-start" className="animate-spin" />{t('proxy.checking')}</> : t('detect.startSampling')}</Button>
                </>
              ) : (
                <Button className="h-9" disabled={filled === 0} onClick={() => verify()}>{filled === 0 ? t('detect.verifyLocked') : filled < 3 ? t('detect.verifyPartial', { n: filled }) : t('detect.verify')}</Button>
              )}
            </>
          )}
        </div>
      </div>

      <ProxyConsentDialog request={active ? connection.request : null} onAnswer={connection.answer} />

      <Dialog open={active && errorDetail !== null} onOpenChange={open => !open && setErrorDetail(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('detect.errorDetails')}</DialogTitle>
            <DialogDescription className="sr-only">{t('detect.errorDetails')}</DialogDescription>
          </DialogHeader>
          <pre tabIndex={0} className="fp-mono rr-mask max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-meta [overflow-wrap:anywhere]">{errorDetail ?? ''}</pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}
