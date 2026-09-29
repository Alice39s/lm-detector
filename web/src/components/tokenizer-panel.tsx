import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Check, CircleCheck, Loader2, OctagonAlert, TriangleAlert, X } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PixelShader, PixelSpinner } from '@/components/pixel-shader'
import { AnimatedPercent, ConfidenceBar } from '@/components/result-panel'
import { useI18n, type MessageKey } from '@/i18n'
import { brandLogos } from '@/lib/brand-logos'
import { describeError, rawMessage } from '@/lib/errors'
import { listItem, listStagger, useMotionPreset } from '@/lib/motion'
import type { TokenizerSession } from '@/lib/use-tokenizer-probe'
import { cn } from '@/lib/utils'
import type { TokenizerBank, TokenizerClass } from '@fingerpoint/shared/tokenizer-bank'
import type { ProbeStep } from '@fingerpoint/shared/tokenizer-probe'
import { probingDone, tokenizerVerdict, type TokenizerVerdict } from '@fingerpoint/shared/tokenizer-posterior'

const VISIBLE = 6
/** Tokenizer authors whose brand logo the reference library already draws. */
const labLogos: Record<string, string> = {
  openai: 'gpt', deepseek: 'deepseek', google: 'gemini', zhipu: 'glm', tencent: 'hunyuan', moonshot: 'kimi',
  xiaomi: 'mimo', meta: 'muse', qwen: 'qwen', stepfun: 'step', anthropic: 'claude', xai: 'grok',
}
/** Classes whose counts a relay can also produce by estimating usage with tiktoken. */
const estimatedUsageClasses = new Set(['o200k', 'cl100k'])
const categories = ['ascii', 'punctuation', 'whitespace', 'digits', 'emoji', 'cjk', 'cjk_rare', 'code', 'latin_ext', 'latin', 'cyrillic', 'arabic', 'devanagari', 'thai', 'hebrew', 'korean', 'japanese', 'greek', 'bytes', 'math', 'structured', 'prose', 'armenian', 'georgian', 'indic', 'sea', 'other_script', 'symbol', 'repeat'] as const
const toneClass = { success: 'bg-success/12 text-success', warning: 'bg-warning/15 text-warning', muted: 'bg-muted text-muted-foreground' }
const kindTone = { exact: 'success', related: 'warning', unknown: 'muted' } as const

function useNames(bank: TokenizerBank) {
  const { locale, t } = useI18n()
  return useMemo(() => {
    const byId = new Map(bank.classes.map(item => [item.id, item]))
    const series = (item: TokenizerClass) => locale === 'zh' ? item.series_zh : item.series
    const category = (name: string) => (categories as readonly string[]).includes(name) ? t(`tokenizer.category.${name}` as MessageKey) : name
    return { byId, series, category }
  }, [bank, locale, t])
}

function ProbeLabel({ bank, step }: { bank: TokenizerBank; step: ProbeStep }) {
  const { t } = useI18n()
  const { category } = useNames(bank)
  if (step.probe === null) return <span className="min-w-0 truncate">{t('tokenizer.baseline')}</span>
  const probe = bank.probes.find(item => item.id === step.probe)
  return <span className="flex min-w-0 items-baseline gap-2">
    <span className="shrink-0">{category(probe?.category ?? '')}</span>
    <span className="fp-mono min-w-0 truncate text-meta text-muted-foreground" title={probe?.text}>{probe?.text.replace(/\s+/g, ' ')}</span>
  </span>
}

function RequestLog({ bank, steps, onShowError }: { bank: TokenizerBank; steps: ProbeStep[]; onShowError: (detail: string) => void }) {
  const { t, number } = useI18n()
  const baseline = steps.find(step => step.probe === null && step.tokens !== undefined)?.tokens
  return (
    <section className="fp-card flex min-w-0 flex-col" aria-labelledby="tokenizer-requests">
      <div className="flex h-12 items-center justify-between gap-2 border-b border-border px-4">
        <h3 id="tokenizer-requests" className="text-card-title">{t('tokenizer.requests')}</h3>
        <span className="text-meta text-muted-foreground">{t('tokenizer.requestCount', { n: steps.length })}</span>
      </div>
      <ol className="flex flex-col px-4 lg:max-h-[28rem] lg:overflow-y-auto" tabIndex={0} aria-labelledby="tokenizer-requests">
        {steps.map((step, index) => {
          const stopped = step.errorCode === 'aborted'
          const delta = step.tokens !== undefined && baseline !== undefined && step.probe !== null ? step.tokens - baseline : undefined
          return (
            <li key={`${index}:${step.probe}`} className="grid min-h-11 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2 text-body first:border-t-0">
              {step.state === 'requesting' ? <Loader2 className="size-4 animate-spin text-warning" aria-label={t('detect.state.requesting')} />
                : step.state === 'done' ? <Check className="size-4 text-success" aria-hidden="true" />
                : <X className={cn('size-4', stopped ? 'text-muted-foreground' : 'text-destructive')} aria-hidden="true" />}
              <ProbeLabel bank={bank} step={step} />
              {step.state === 'failed'
                ? stopped ? <span className="text-meta text-muted-foreground">{t('tokenizer.stopped')}</span>
                  : <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive hover:text-destructive" onClick={() => onShowError(step.error ?? '')}>{t('tokenizer.failed')}</Button>
                : <span className="fp-mono text-right text-meta">
                    {step.tokens === undefined ? '—' : number(step.tokens)}
                    {delta !== undefined && <span className="text-muted-foreground"> · +{number(delta)}</span>}
                  </span>}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Summary({ bank, verdict, provisional }: { bank: TokenizerBank; verdict: TokenizerVerdict; provisional: boolean }) {
  const { t } = useI18n()
  const { byId, series } = useNames(bank)
  const top = byId.get(verdict.top.id) as TokenizerClass
  const logo = verdict.kind !== 'unknown' ? brandLogos[labLogos[top.lab] ?? ''] : undefined
  const tone = kindTone[verdict.kind]
  return (
    <div className="fp-card p-4">
      <div className="fp-result-summary">
        <div className="flex min-w-0 flex-col-reverse items-start gap-2 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-meta text-muted-foreground">{t(provisional ? 'tokenizer.provisional' : 'tokenizer.topLabel')}</span>
            <span className="text-display [overflow-wrap:anywhere]">{verdict.kind === 'unknown' ? t('tokenizer.unknownTitle') : series(top)}</span>
            <span className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
              <Badge className={cn('h-[22px] rounded-[var(--radius-badge)] px-2 text-meta font-medium', toneClass[tone])}>{t(`tokenizer.kind.${verdict.kind}`)}</Badge>
              {verdict.kind === 'unknown' ? t('tokenizer.closest', { name: series(top) }) : top.lab_name}
            </span>
          </div>
          {logo && <PixelShader effect="logo" image={logo} className="size-12 shrink-0 text-foreground sm:size-18" />}
        </div>
        <div className="fp-result-score flex flex-col items-end gap-1 text-right">
          <AnimatedPercent value={verdict.confidence} className="text-display-number" />
          <span className="text-meta text-muted-foreground">{t('tokenizer.probability')}</span>
          <span className="text-meta text-muted-foreground">{t('detect.resultSourceBefore')}<span className="fp-mono">lm.ikale.io</span>{t('detect.resultSourceAfter')}</span>
        </div>
      </div>
    </div>
  )
}

function Claim({ bank, verdict, model }: { bank: TokenizerBank; verdict: TokenizerVerdict; model: string }) {
  const { t } = useI18n()
  const { byId, series } = useNames(bank)
  const claim = verdict.claim
  if (!model) return null
  if (!claim) return <p className="text-body text-muted-foreground">{t('tokenizer.claimUnregistered', { model })}</p>
  const expected = claim.expected.length
    ? claim.expected.map(id => { const item = byId.get(id); return item ? series(item) : id }).join(' / ')
    : t('tokenizer.unpublished', { vendor: claim.vendor })
  if (claim.status === 'consistent') {
    return <Alert className="p-4 *:[svg]:text-success"><CircleCheck aria-hidden="true" /><AlertTitle>{t('tokenizer.claimConsistent', { model, expected })}</AlertTitle></Alert>
  }
  if (claim.status === 'inconsistent') {
    return <Alert variant="destructive" className="p-4"><OctagonAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.claimInconsistent', { model, expected })}</AlertTitle></Alert>
  }
  return <Alert variant="warning" className="p-4"><TriangleAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.claimUncertain', { model, expected })}</AlertTitle></Alert>
}

function Candidates({ bank, session }: { bank: TokenizerBank; session: TokenizerSession }) {
  const { t, percent } = useI18n()
  const { smooth, reduced } = useMotionPreset()
  const { byId, series } = useNames(bank)
  const posterior = session.run?.posterior
  if (!posterior) return null
  const rows = posterior.classes.slice(0, VISIBLE)
  return (
    <motion.ol className="fp-card px-4" variants={reduced ? undefined : listStagger} initial={reduced ? false : 'hidden'} animate="show" aria-label={t('tokenizer.candidates')}>
      {rows.map((score, i) => {
        const item = byId.get(score.id) as TokenizerClass
        return (
          <motion.li key={score.id} layout={reduced ? false : 'position'} transition={smooth} className="fp-result-row text-body" variants={reduced ? undefined : listItem}>
            <span className="text-muted-foreground">{i + 1}</span>
            <span className="fp-result-name min-w-0 break-words font-medium">{series(item)}</span>
            <span className="fp-result-family truncate text-muted-foreground">{item.lab_name}</span>
            <ConfidenceBar value={score.exact} />
            <span className="fp-result-percent text-right">{percent(score.exact)}</span>
          </motion.li>
        )
      })}
      <li className="fp-result-row text-body">
        <span className="text-muted-foreground">—</span>
        <span className="fp-result-name min-w-0 font-medium">{t('tokenizer.unlisted')}</span>
        <span className="fp-result-family truncate text-muted-foreground" />
        <ConfidenceBar value={posterior.unknown} />
        <span className="fp-result-percent text-right">{percent(posterior.unknown)}</span>
      </li>
    </motion.ol>
  )
}

function Evidence({ bank, session, verdict }: { bank: TokenizerBank; session: TokenizerSession; verdict: TokenizerVerdict }) {
  const { t, number } = useI18n()
  const { byId, series } = useNames(bank)
  const top = byId.get(verdict.top.id) as TokenizerClass
  const index = new Map(bank.probes.map((probe, j) => [probe.id, j]))
  const rows = (session.run?.observations ?? []).filter(observation => observation.probe !== null)
  return (
    <details className="text-body">
      <summary className="cursor-pointer text-muted-foreground">{t('tokenizer.evidence')}</summary>
      <div className="mt-3 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('tokenizer.colProbe')}</TableHead>
              <TableHead className="text-right">{t('tokenizer.colObserved')}</TableHead>
              <TableHead className="text-right">{t('tokenizer.colExpected')} · {series(top)}</TableHead>
              <TableHead className="text-right">{t('tokenizer.colMatch')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(observation => {
              const j = index.get(observation.probe as string) as number
              const allowed = top.alternatives?.[j] ?? [top.counts[j]]
              const delta = observation.tokens - verdict.top.overhead
              const ok = allowed.includes(delta)
              return (
                <TableRow key={observation.probe}>
                  <TableCell className="max-w-[18rem]"><ProbeLabel bank={bank} step={{ probe: observation.probe, state: 'done' }} /></TableCell>
                  <TableCell className="fp-mono text-right">{number(delta)}</TableCell>
                  <TableCell className="fp-mono text-right">{allowed.map(value => number(value)).join(' / ')}</TableCell>
                  <TableCell className={cn('text-right', ok ? 'text-success' : 'text-destructive')}>{t(ok ? 'tokenizer.match' : 'tokenizer.mismatch')}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </details>
  )
}

export function TokenizerIdle() {
  const { t } = useI18n()
  return (
    <div className="fp-card relative isolate flex flex-col gap-2 overflow-hidden p-4">
      <PixelShader effect="dither" className="absolute inset-0 -z-10 text-muted-foreground/20" />
      <span className="text-card-title">{t('tokenizer.idleTitle')}</span>
      <p className="max-w-3xl text-body text-muted-foreground">{t('tokenizer.idleBody')}</p>
    </div>
  )
}

export function TokenizerPanel({ session, onShowError }: { session: TokenizerSession; onShowError: (detail: string) => void }) {
  const i18n = useI18n()
  const { t } = i18n
  const { bank, run, phase, config } = session
  const probing = phase === 'probing' || phase === 'loading'
  // A settled run shows only its own verdict; a provisional one is computed while probes are still arriving.
  const verdict = useMemo(() => {
    if (!bank || !run) return null
    if (run.verdict || phase === 'result') return run.verdict
    return run.posterior && run.posterior.answered > 0 ? tokenizerVerdict(bank, run.posterior, config?.model ?? '') : null
  }, [bank, run, config, phase])
  const failure = session.error ?? (run?.error && run.error.code !== 'aborted' ? run.error : null)
  // The closing baseline runs after the posterior settled; its failure leaves the verdict intact.
  const settledBeforeFailure = Boolean(run?.verdict && run.posterior && probingDone(run.posterior))
  const models = [...new Set((run?.observations ?? []).map(observation => observation.responseModel).filter((model): model is string => Boolean(model)))]
  const answered = run?.steps.filter(step => step.state === 'done').length ?? 0

  return (
    <section className="flex flex-col gap-6" aria-labelledby="tokenizer-title">
      <div className="flex flex-col gap-1">
        <h2 id="tokenizer-title" className="text-section-title">{t('tokenizer.title')}</h2>
        {bank && <p className="text-body text-muted-foreground">{t('tokenizer.intro', { classes: bank.classes.length, tokenizers: bank.source.tokenizers })}</p>}
      </div>
      {phase === 'idle' && <TokenizerIdle />}
      {probing && (
        <div className="flex h-12 items-center gap-2 text-body text-muted-foreground" role="status">
          <PixelSpinner />
          {phase === 'loading' ? t('tokenizer.loading') : t('tokenizer.probing', { n: answered })}
          <PixelShader effect="scan" cell={3} className="h-6 min-w-0 flex-1 text-muted-foreground/60" />
        </div>
      )}
      {failure && (
        <Alert variant="destructive" className="p-4">
          <OctagonAlert aria-hidden="true" />
          <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
            {settledBeforeFailure ? t('tokenizer.baselineCheckFailed', { reason: describeError(i18n, failure) })
              : run?.verdict ? t('tokenizer.stoppedEarly', { reason: describeError(i18n, failure) })
              : describeError(i18n, failure, 'tokenizer.bankFailed')}
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onShowError(rawMessage(failure))}>{t('detect.viewError')}</Button>
          </AlertTitle>
        </Alert>
      )}
      {bank && run && run.steps.length > 0 && (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {verdict && <Summary bank={bank} verdict={verdict} provisional={phase !== 'result'} />}
            {verdict && phase === 'result' && <Claim bank={bank} verdict={verdict} model={config?.model ?? ''} />}
            {verdict && phase === 'result' && verdict.kind === 'exact' && estimatedUsageClasses.has(verdict.top.id) && verdict.claim?.status !== 'consistent' && (
              <Alert variant="warning" className="p-4"><TriangleAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.estimatedUsage')}</AlertTitle></Alert>
            )}
            {run.baselineDrift && <Alert variant="warning" className="p-4"><TriangleAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.baselineDrift')}</AlertTitle></Alert>}
            <Candidates bank={bank} session={session} />
            {models.length > 0 && <p className="text-meta text-muted-foreground">{t('tokenizer.returnedModel', { models: models.join(', ') })}</p>}
          </div>
          <RequestLog bank={bank} steps={run.steps} onShowError={onShowError} />
        </div>
      )}
      {bank && verdict && phase === 'result' && (
        <div className="flex flex-col gap-2 text-body text-muted-foreground">
          {verdict.kind !== 'unknown' && (
            <details>
              <summary className="cursor-pointer">{t('tokenizer.members', { n: bank.classes.find(item => item.id === verdict.top.id)?.members.length ?? 0 })}</summary>
              <p className="fp-mono mt-2 text-meta [overflow-wrap:anywhere]">{bank.classes.find(item => item.id === verdict.top.id)?.members.join(' · ')}</p>
            </details>
          )}
          <Evidence bank={bank} session={session} verdict={verdict} />
          <details>
            <summary className="cursor-pointer">{t('tokenizer.limitsTitle')}</summary>
            <p className="mt-2">{t('tokenizer.limitsDetail')}</p>
            <p className="mt-2">{t('tokenizer.limitsCounting')}</p>
          </details>
        </div>
      )}
    </section>
  )
}
