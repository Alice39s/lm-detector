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
import { ResultPanel } from '@/components/result-panel'
import { SampleCard, SampleStrip, isBusyState, type Mode, type SampleUI } from '@/components/sample-card'
import { TokenizerPanel } from '@/components/tokenizer-panel'
import { ProxyConsentDialog } from '@/components/proxy-consent-dialog'
import { useI18n } from '@/i18n'
import * as client from '@/lib/client'
import { configComplete, useApiConfig, type WebApiConfig } from '@/lib/config'
import { describeError } from '@/lib/errors'
import { exportResultImage } from '@/lib/export-image'
import { useMotionPreset } from '@/lib/motion'
import { useModelMatchCelebration } from '@/lib/use-model-match-celebration'
import { useTokenizerProbe } from '@/lib/use-tokenizer-probe'
import { useConnectionRoute } from '@/lib/use-connection-route'
import { forgetReachability } from '@/lib/route'
import { cn } from '@/lib/utils'
import { endpoint } from '@fingerpoint/shared/detection'
import type { Analysis, Challenge, CodedError, CollectionProgress } from '@fingerpoint/shared/types'
import { redactPrivateMetadata } from '@fingerpoint/shared/privacy'
import { anomalousSamples } from '@fingerpoint/shared/sample-distribution'

type Phase = 'edit' | 'sampling' | 'computing' | 'result'
/** Manual and API modes share the three samples; tokenizer mode probes the API with its own requests. */
type DetectMode = Mode | 'tokenizer'
const idle = (): SampleUI => ({ text: '', state: 'idle' })
const cliCommands: Record<DetectMode, string[]> = {
  manual: ['bunx', 'lmfpd@latest', '--help'],
  api: ['bunx', 'lmfpd@latest', '--help'],
  tokenizer: ['bunx', 'lmfpd@latest tokenizer', '--help'],
}
const modeParam = (value: string | null): DetectMode => value === 'api' || value === 'tokenizer' ? value : 'manual'
type Run = { controller: AbortController; indexes: number[] }

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
  const [mode, setMode] = useState<DetectMode>(() => modeParam(params.get('mode')))
  useEffect(() => {
    if (active && modeParam(params.get('mode')) !== mode) {
      setParams(mode === 'manual' ? {} : { mode }, { replace: true })
    }
  }, [active, mode, params, setParams])
  const tokenizer = useTokenizerProbe(active)
  const connection = useConnectionRoute()
  const cliCommand = cliCommands[mode].join(' ')

  const [challenges, setChallenges] = useState<Challenge[]>(() => client.generateChallenges(3))
  const [samples, setSamples] = useState<SampleUI[]>(() => [idle(), idle(), idle()])
  const [phase, setPhase] = useState<Phase>('edit')
  const [result, setResult] = useState<Analysis | null>(null)
  const [resultModel, setResultModel] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [config, update, profileManager] = useApiConfig(() => toast.error(t('errors.unknown')))
  const previousProfileId = useRef(profileManager.activeId)
  const [apiConfigOpen, setApiConfigOpen] = useState(() => !configComplete(config))
  const apiConfigRef = useRef<HTMLDivElement>(null)
  const activeRun = useRef<Run | null>(null)
  const mounted = useRef(true)
  const samplesRef = useRef(samples)
  const challengesRef = useRef(challenges)
  const sampledConfigs = useRef<(WebApiConfig | undefined)[]>([])
  const resultRef = useRef(result)
  useLayoutEffect(() => {
    if (previousProfileId.current === profileManager.activeId) return
    previousProfileId.current = profileManager.activeId
    restart()
  }, [profileManager.activeId])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const run = activeRun.current
      activeRun.current = null
      run?.controller.abort()
    }
  }, [])

  const filled = samples.filter(s => s.text.trim()).length
  const locked = phase === 'sampling' || phase === 'computing' || tokenizer.busy || connection.checking || connection.request !== null
  const canSample = configComplete(config) && !locked
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
    resultRef.current = null
    setResult(null)
  }

  function stop() {
    const run = activeRun.current
    if (!run) return
    activeRun.current = null
    run.controller.abort()
    replaceSamples(samplesRef.current.map((sample, i) => run.indexes.includes(i) && isBusyState(sample.state)
      ? { ...sample, state: 'stopped', draftText: sample.text.trim() ? undefined : sample.draftText, errorCode: undefined, errorText: undefined }
      : sample))
    setPhase(resultRef.current ? 'result' : 'edit')
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

  async function startTokenizer() {
    if (locked || !requireConfig(config)) return
    const frozen = { ...config }
    const route = await resolveRoute(frozen)
    if (!route || !mounted.current) return
    const run = await tokenizer.start(frozen, route)
    recheckAfter(route, frozen, run?.error?.code === 'network')
  }

  async function sampleIndexes(indexes: number[], requestConfig: WebApiConfig = config) {
    if (!indexes.length || activeRun.current || !mounted.current || connection.checking) return
    if (!requireConfig(requestConfig)) return
    const route = await resolveRoute(requestConfig)
    if (!route || activeRun.current || !mounted.current) return
    const frozenConfig = { ...requestConfig, parallel: indexes.length > 1 && (requestConfig.parallel ?? false) }
    const run: Run = { controller: new AbortController(), indexes: [...indexes] }
    activeRun.current = run
    const current = () => mounted.current && activeRun.current === run && !run.controller.signal.aborted
    const startedAt = new Map<number, number>()
    const accepted = new Set<number>()
    setPhase('sampling')
    replaceSamples(samplesRef.current.map((sample, i) => indexes.includes(i)
      ? { ...sample, draftText: '', state: 'pending', errorCode: undefined, httpStatus: undefined, errorText: undefined, elapsedMs: undefined, throughput: undefined }
      : sample))

    function applyProgress(progress: CollectionProgress) {
      if (!current() || !progress.challenges) return
      progress.challenges.forEach((challenge, k) => {
        const index = indexes[k]
        if (index === undefined || accepted.has(index)) return
        const state = challenge.state ?? 'pending'
        if (state === 'requesting' && !startedAt.has(index)) startedAt.set(index, performance.now())
        const finished = state === 'done' || state === 'capped' || state === 'rejected'
        const elapsedMs = finished && startedAt.has(index) ? performance.now() - startedAt.get(index)! : undefined
        if ((state === 'done' || state === 'capped') && challenge.text.trim()) {
          accepted.add(index)
          sampledConfigs.current[index] = frozenConfig
          patch(index, { text: challenge.text, draftText: undefined, state, elapsedMs, throughput: challenge.throughput, errorCode: undefined, httpStatus: undefined, errorText: undefined })
          clearResult()
        } else {
          const previous = samplesRef.current[index]
          patch(index, {
            draftText: state === 'rejected' && previous.text.trim() ? undefined : challenge.text,
            state, elapsedMs, throughput: challenge.throughput,
            errorCode: state === 'rejected' ? challenge.errorCode : undefined,
            httpStatus: state === 'rejected' ? challenge.httpStatus : undefined,
            errorText: state === 'rejected' ? safeError(challenge.error, frozenConfig.apiKey) : undefined,
          })
        }
      })
    }

    try {
      await client.testApi(frozenConfig, indexes.map(i => challengesRef.current[i]), applyProgress, route, run.controller.signal)
    } catch (error) {
      if (!current()) return
      const coded = error as CodedError
      replaceSamples(samplesRef.current.map((sample, i) => indexes.includes(i) && isBusyState(sample.state)
        ? { ...sample, state: 'rejected', draftText: sample.text.trim() ? undefined : sample.draftText, errorCode: coded?.code, httpStatus: coded?.httpStatus, errorText: safeError(error instanceof Error ? error.message : undefined, frozenConfig.apiKey) }
        : sample))
    }
    recheckAfter(route, frozenConfig, indexes.some(i => samplesRef.current[i].errorCode === 'network'))
    if (!current()) return
    activeRun.current = null
    setPhase(resultRef.current ? 'result' : 'edit')
    if (frozenConfig.autoVerify && accepted.size === indexes.length && samplesRef.current.every(sample => sample.text.trim())) {
      void verify()
    }
  }

  async function verify() {
    if (activeRun.current || !mounted.current || !samplesRef.current.some(sample => sample.text.trim())) return
    const run: Run = { controller: new AbortController(), indexes: [] }
    activeRun.current = run
    const outputs = samplesRef.current.map((sample, i) => ({ text: sample.text, expected_count: challengesRef.current[i].expected_count }))
    setPhase('computing')
    setExpanded(null)
    try {
      const analysis = await client.analyze(outputs, bank)
      if (!mounted.current || activeRun.current !== run) return
      resultRef.current = analysis
      setResultModel(mode === 'api' ? config.model : null)
      setResult(analysis)
      setPhase('result')
    } catch (error) {
      if (!mounted.current || activeRun.current !== run) return
      toast.error(describeError(i18n, error, 'errors.analyze'))
      setPhase(resultRef.current ? 'result' : 'edit')
    } finally {
      if (activeRun.current === run) activeRun.current = null
    }
  }

  function restart() {
    stop()
    replaceChallenges(client.generateChallenges(3))
    replaceSamples([idle(), idle(), idle()])
    sampledConfigs.current = []
    clearResult()
    setExpanded(null)
    setPhase('edit')
  }

  /** Abnormal distributions follow the prompt, so retrying them needs new prompts. */
  function replacePrompts(indexes: number[]) {
    if (activeRun.current) return
    const kept = challengesRef.current.filter((_, i) => !indexes.includes(i)).map(challenge => challenge.expected_count)
    const fresh = client.generateChallenges(indexes.length, kept)
    replaceChallenges(challengesRef.current.map((challenge, i) => indexes.includes(i) ? fresh[indexes.indexOf(i)] : challenge))
    replaceSamples(samplesRef.current.map((sample, i) => indexes.includes(i) ? idle() : sample))
    clearResult()
    setExpanded(null)
    setPhase('edit')
    if (mode === 'api') void sampleIndexes(indexes, sampledConfigs.current[indexes[0]] ?? config)
  }

  function edit(i: number, text: string) {
    if (activeRun.current) return
    patch(i, { text, draftText: undefined, state: 'idle', errorCode: undefined, httpStatus: undefined, errorText: undefined, elapsedMs: undefined, throughput: undefined })
    clearResult()
    setPhase('edit')
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

  function collapseSample(index: number) {
    setExpanded(null)
    document.getElementById(`sample-trigger-${index}`)?.focus({ preventScroll: true })
  }

  function renderSample(index: number, collapsible = false) {
    return <SampleCard
      key={challenges[index].id}
      index={index}
      challenge={challenges[index]}
      sample={samples[index]}
      mode={mode === 'api' ? 'api' : 'manual'}
      canSample={canSample}
      locked={locked}
      onChange={text => edit(index, text)}
      onResample={() => sampleIndexes([index], sampledConfigs.current[index] ?? config)}
      onStop={stop}
      onShowError={() => setErrorDetail(samples[index].errorText ?? null)}
      onCollapse={collapsible ? () => collapseSample(index) : undefined}
      anomalous={anomalous.includes(index)}
    />
  }

  return (
    <div className={cn('fp-page', 'has-actionbar')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-h1">{t('detect.title')}</h1>
        <Segmented label={t('detect.modeLabel')} value={mode} onChange={m => { if (!activeRun.current && !tokenizer.busy) setMode(m) }} disabled={locked} options={[{ value: 'manual', label: t('detect.modeManual') }, { value: 'api', label: t('detect.modeApi') }, { value: 'tokenizer', label: t('detect.modeTokenizer') }]} />
      </div>

      <aside className="fp-cli-promo relative isolate overflow-hidden" aria-label={t('detect.cliTitle')}>
        <PixelShader effect="rain" className="absolute inset-0 -z-10 text-muted-foreground/30 [mask-image:linear-gradient(90deg,transparent_25%,#000_70%)]" />
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <strong className="shrink-0 font-medium">{t('detect.cliTitle')}</strong>
          <span className="text-muted-foreground">{t('detect.cliDescription')}</span>
        </div>
        <button type="button" className="fp-cli-command" onClick={copyCliCommand} aria-label={t('detect.cliCopy', { command: cliCommand })} title={t('detect.cliCopy', { command: cliCommand })}>
          <code className="fp-mono text-meta"><span>{cliCommands[mode][0]}</span> {cliCommands[mode][1]} <span>{cliCommands[mode][2]}</span></code>
          <Copy className="size-3.5 shrink-0" aria-hidden="true" />
        </button>
        <a href="https://github.com/Ikaleio/lm-detector#%E6%A3%80%E6%B5%8B-cli" target="_blank" rel="noopener noreferrer" className="fp-cli-link">
          <span className="sm:hidden">{t('detect.cliGuideShort')}</span>
          <span className="hidden sm:inline">{t('detect.cliGuide')}</span>
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a>
      </aside>

      <AnimatePresence initial={false}>
        {mode !== 'manual' && <motion.div
          key="api-configuration"
          initial={{ height: 0, opacity: 0, marginBottom: -24 }}
          animate={{ height: 'auto', opacity: 1, marginBottom: 0 }}
          exit={{ height: 0, opacity: 0, marginBottom: -24 }}
          transition={snappy}
          className="shrink-0 overflow-hidden"
        >
          <ApiConfigPanel containerRef={apiConfigRef} open={apiConfigOpen} onOpenChange={setApiConfigOpen} config={config} update={update} profileManager={profileManager} disabled={locked} variant={mode === 'tokenizer' ? 'tokenizer' : 'sampling'} />
        </motion.div>}
      </AnimatePresence>

      {mode === 'tokenizer' ? (
        <TokenizerPanel session={tokenizer.session} onShowError={detail => setErrorDetail(safeError(detail, tokenizer.session.config?.apiKey ?? config.apiKey) ?? '')} />
      ) : <>
      <section className="flex flex-col gap-4" aria-label={t('detect.samples')}>
        {showStrip && <SampleStrip samples={samples} challenges={challenges} expanded={expanded} anomalous={anomalous} onToggle={i => setExpanded(e => (e === i ? null : i))} />}
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
              {renderSample(expanded, true)}
            </motion.div>}
          </AnimatePresence>
        ) : <div className="fp-grid-samples">{challenges.map((_, index) => renderSample(index))}</div>}
      </section>

      {phase === 'computing' && (
        <div className="flex h-12 items-center gap-2 text-body text-muted-foreground" role="status">
          <PixelSpinner />
          {t('detect.computing')}
          <PixelShader effect="scan" cell={3} className="h-6 min-w-0 flex-1 text-muted-foreground/60" />
        </div>
      )}
      {phase === 'result' && result && <ResultPanel result={result} anomalous={anomalous} mode={mode} onReplacePrompts={() => replacePrompts(anomalous)} />}
      </>}

      <div className="fp-detect-footer">
        <a href="https://github.com/Ikaleio/lm-detector" target="_blank" rel="noopener noreferrer" className="fp-star-link">
          <Star className="size-4" aria-hidden="true" />
          {t('detect.starRequest')}
        </a>
        <div className="fp-actionbar">
          {mode === 'tokenizer' ? (
            tokenizer.busy ? (
              <>
                <Button variant="outline" className="h-9" onClick={tokenizer.stop}>{t('detect.stop')}</Button>
                <Button className="h-9" disabled><Loader2 data-icon="inline-start" className="animate-spin" />{t('tokenizer.running')}</Button>
              </>
            ) : tokenizer.session.phase === 'result' ? (
              <>
                {tokenizer.session.run && tokenizer.session.bank && tokenizer.session.config && <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={t('detect.more')} />}><MoreVertical /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem onClick={() => {
                    const { run, bank, config: frozen, startedAt } = tokenizer.session
                    if (run && bank && frozen) client.exportTokenizerRun(run, bank, frozen, startedAt)
                  }}>{t('detect.exportJson')}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent>
                </DropdownMenu>}
                <Button className="h-9" disabled={locked} onClick={startTokenizer}>{connection.checking ? <><Loader2 data-icon="inline-start" className="animate-spin" />{t('proxy.checking')}</> : t('tokenizer.restart')}</Button>
              </>
            ) : (
              <Button className="h-9" disabled={locked} onClick={startTokenizer}>{connection.checking ? <><Loader2 data-icon="inline-start" className="animate-spin" />{t('proxy.checking')}</> : t('tokenizer.start')}</Button>
            )
          ) : phase === 'result' ? (
            <>
              {result && <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={t('detect.more')} />}><MoreVertical /></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem onClick={() => client.exportAnalysis(result)}>{t('detect.exportJson')}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent>
              </DropdownMenu>}
              <Button variant="outline" className="h-9" onClick={saveImage}>{t('detect.saveImage')}</Button>
              <Button className="h-9" onClick={restart}>{t('detect.restart')}</Button>
            </>
          ) : phase === 'sampling' ? (
            <>
              <Button variant="outline" className="h-9" onClick={stop}>{t('detect.stop')}</Button>
              <Button className="h-9" disabled><Loader2 data-icon="inline-start" className="animate-spin" />{t('detect.sampling')}</Button>
            </>
          ) : phase === 'computing' ? (
            <Button className="h-9" disabled><PixelSpinner data-icon="inline-start" />{t('detect.computing')}</Button>
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
