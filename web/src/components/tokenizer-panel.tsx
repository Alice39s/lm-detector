import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Check, ChevronDown, Loader2, MoreVertical, OctagonAlert, TriangleAlert, X } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PixelShader } from '@/components/pixel-shader'
import { ConfidenceBar } from '@/components/result-panel'
import { toneClass } from '@/components/sample-card'
import { ClaimAlert, useTokenizerNames } from '@/components/tokenizer-claim'
import { useI18n } from '@/i18n'
import { describeError, errorReason, rawMessage } from '@/lib/errors'
import { listItem, listStagger, useMotionPreset } from '@/lib/motion'
import type { TokenizerSession } from '@/lib/use-tokenizer-probe'
import { cn } from '@/lib/utils'
import type { TokenizerBank, TokenizerClass } from '@fingerpoint/shared/tokenizer-bank'
import type { ProbeStep } from '@fingerpoint/shared/tokenizer-probe'
import { probingDone, tokenizerVerdict, type TokenizerVerdict } from '@fingerpoint/shared/tokenizer-posterior'

const VISIBLE = 6
const kindTone = { exact: 'success', related: 'warning', unknown: 'muted' } as const

/** A settled run shows only its own verdict; a provisional one is computed while probes are still arriving. */
function useVerdict(session: TokenizerSession) {
  const { bank, run, config, phase } = session
  return useMemo(() => {
    if (!bank || !run) return null
    if (run.verdict || phase === 'result') return run.verdict
    return run.posterior && run.posterior.answered > 0 ? tokenizerVerdict(bank, run.posterior, config?.model ?? '') : null
  }, [bank, run, config, phase])
}

type Status = 'probing' | 'exact' | 'related' | 'unknown' | 'failed' | 'stopped'
function statusOf(session: TokenizerSession, verdict: TokenizerVerdict | null): Status {
  if (session.phase === 'loading' || session.phase === 'probing') return 'probing'
  if (session.run?.error?.code === 'aborted' && !verdict) return 'stopped'
  if (!verdict) return 'failed'
  return verdict.kind
}
const statusTone: Record<Status, keyof typeof toneClass> = { probing: 'warning', ...kindTone, failed: 'destructive', stopped: 'muted' }

function StatusBadge({ status }: { status: Status }) {
  const { t } = useI18n()
  return (
    <Badge className={cn('h-[22px] rounded-[var(--radius-badge)] px-2 text-meta font-medium', toneClass[statusTone[status]])}>
      {status === 'probing' && <Loader2 className="animate-spin" />}
      {t(status === 'probing' || status === 'failed' || status === 'stopped' ? `tokenizer.state.${status}` : `tokenizer.kind.${status}`)}
    </Badge>
  )
}

/** The failure that ended the run before a verdict, or null when the run settled or was stopped. */
function failureOf(session: TokenizerSession) {
  const error = session.error ?? session.run?.error ?? null
  return error && error.code !== 'aborted' ? error : null
}

function SummaryLine({ session, verdict }: { session: TokenizerSession; verdict: TokenizerVerdict | null }) {
  const i18n = useI18n()
  const { t, percent } = i18n
  const { byId, series } = useTokenizerNames(session.bank)
  const failure = failureOf(session)
  if (session.phase === 'loading') return <>{t('tokenizer.loading')}</>
  if (!verdict) {
    if (session.phase === 'probing') return <>{t('tokenizer.baselinePending')}</>
    if (failure) return <>{t('tokenizer.unavailable', { reason: errorReason(i18n, failure, 'tokenizer.bankFailed') })}</>
    return <>{t('tokenizer.stopped')}</>
  }
  const top = byId.get(verdict.top.id) as TokenizerClass
  const label = verdict.kind === 'unknown' ? `${t('tokenizer.unknownTitle')} · ${t('tokenizer.closest', { name: series(top) })}` : `${series(top)} · ${top.lab_name}`
  return <>{t(session.phase === 'result' ? 'tokenizer.settled' : 'tokenizer.leading', { name: label, p: percent(verdict.confidence) })}</>
}

/** Status of the probe beside the three sample cards while sampling. */
export function TokenizerCard({ session, onShowError, onRetry, canRetry }: { session: TokenizerSession; onShowError: (detail: string) => void; onRetry: () => void; canRetry: boolean }) {
  const { t } = useI18n()
  const verdict = useVerdict(session)
  const status = statusOf(session, verdict)
  const failure = failureOf(session)
  const answered = session.run?.steps.filter(step => step.state === 'done').length ?? 0
  const busy = status === 'probing'
  return (
    <section className="fp-card flex min-w-0 flex-col gap-3 p-4" aria-labelledby="tokenizer-card-title" aria-busy={busy}>
      <div className="flex h-9 items-center justify-between gap-2">
        <h2 id="tokenizer-card-title" className="text-card-title">{t('tokenizer.title')}</h2>
        <div className="flex items-center gap-1">
          <StatusBadge status={status} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={t('detect.more')} />}><MoreVertical /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {failure && <DropdownMenuItem onClick={() => onShowError(rawMessage(failure))}>{t('detect.viewError')}</DropdownMenuItem>}
                <DropdownMenuItem disabled={busy || !canRetry} onClick={onRetry}>{t('tokenizer.retry')}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="relative h-px bg-border">
        {busy && <PixelShader effect="march" cell={2} className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 text-muted-foreground/60" />}
      </div>
      <p className={cn('text-body', failure && !verdict && 'text-destructive')} role="status"><SummaryLine session={session} verdict={verdict} /></p>
      <p className="text-meta text-muted-foreground">
        {t('tokenizer.requestCount', { n: answered })} · {t('tokenizer.help')}
      </p>
    </section>
  )
}

/** Fourth entry of the sample strip; opens the probe details below it. */
export function TokenizerStripButton({ session, expanded, onToggle }: { session: TokenizerSession; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const verdict = useVerdict(session)
  const status = statusOf(session, verdict)
  const { name } = useTokenizerNames(session.bank)
  const detail = verdict && verdict.kind !== 'unknown' ? name(verdict.top.id) : t(status === 'probing' ? 'tokenizer.state.probing' : status === 'unknown' ? 'tokenizer.kind.unknown' : `tokenizer.state.${status === 'stopped' ? 'stopped' : 'failed'}`)
  return (
    <button
      type="button"
      id="tokenizer-trigger"
      className={cn('fp-card flex h-11 min-w-0 items-center justify-between gap-2 px-3 text-left text-body hover:bg-muted', expanded && 'bg-muted')}
      aria-expanded={expanded}
      aria-controls={expanded ? 'tokenizer-panel' : undefined}
      onClick={onToggle}
    >
      <span className="truncate">
        {t('tokenizer.stripLabel')}
        <span className="hidden text-muted-foreground sm:inline"> · {detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {status === 'probing' ? <Loader2 className="size-4 animate-spin text-warning" aria-hidden="true" />
          : status === 'failed' ? <TriangleAlert className="size-4 text-destructive" aria-hidden="true" /> : null}
        <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
      </span>
    </button>
  )
}

function ProbeLabel({ bank, step }: { bank: TokenizerBank; step: ProbeStep }) {
  const { t } = useI18n()
  const { category } = useTokenizerNames(bank)
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
    <section className="flex min-w-0 flex-col rounded-lg border border-border" aria-labelledby="tokenizer-requests">
      <div className="flex h-11 items-center justify-between gap-2 border-b border-border px-3">
        <h3 id="tokenizer-requests" className="text-body font-medium">{t('tokenizer.requests')}</h3>
        <span className="text-meta text-muted-foreground">{t('tokenizer.requestCount', { n: steps.length })}</span>
      </div>
      <ol className="flex flex-col px-3 lg:max-h-[28rem] lg:overflow-y-auto" tabIndex={0} aria-labelledby="tokenizer-requests">
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

function Candidates({ bank, session }: { bank: TokenizerBank; session: TokenizerSession }) {
  const { t, percent } = useI18n()
  const { smooth, reduced } = useMotionPreset()
  const { byId, series } = useTokenizerNames(bank)
  const posterior = session.run?.posterior
  if (!posterior) return null
  return (
    <motion.ol className="rounded-lg border border-border px-3" variants={reduced ? undefined : listStagger} initial={reduced ? false : 'hidden'} animate="show" aria-label={t('tokenizer.candidates')}>
      {posterior.classes.slice(0, VISIBLE).map((score, i) => {
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
  const { byId, series } = useTokenizerNames(bank)
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

/** Probe details, opened from the sample strip after sampling. */
export function TokenizerDetails({ session, onShowError, onCollapse, onRetry, canRetry }: {
  session: TokenizerSession; onShowError: (detail: string) => void; onCollapse: () => void; onRetry: () => void; canRetry: boolean
}) {
  const i18n = useI18n()
  const { t, percent } = i18n
  const { bank, run, phase, config } = session
  const verdict = useVerdict(session)
  const status = statusOf(session, verdict)
  const { byId, series } = useTokenizerNames(bank)
  const failure = failureOf(session)
  // The closing baseline runs after the posterior settled; its failure leaves the verdict intact.
  const settledBeforeFailure = Boolean(run?.verdict && run.posterior && probingDone(run.posterior))
  const models = [...new Set((run?.observations ?? []).map(observation => observation.responseModel).filter((model): model is string => Boolean(model)))]
  const top = verdict ? byId.get(verdict.top.id) : undefined
  return (
    <section id="tokenizer-panel" className="fp-card flex min-w-0 flex-col gap-4 p-4" aria-labelledby="tokenizer-details-title">
      <div className="flex h-9 items-center justify-between gap-2">
        <h2 id="tokenizer-details-title" className="text-card-title">{t('tokenizer.title')}</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onCollapse} aria-label={`${t('detect.collapse')} ${t('tokenizer.title')}`}>
            {t('detect.collapse')}<ChevronDown data-icon="inline-end" className="rotate-180" />
          </Button>
          <StatusBadge status={status} />
        </div>
      </div>
      <p className="text-body text-muted-foreground">{t('tokenizer.help')}</p>
      {failure && (
        <Alert variant="destructive" className="p-4">
          <OctagonAlert aria-hidden="true" />
          <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
            {settledBeforeFailure ? t('tokenizer.baselineCheckFailed', { reason: describeError(i18n, failure) })
              : run?.verdict ? t('tokenizer.stoppedEarly', { reason: describeError(i18n, failure) })
              : t('tokenizer.unavailable', { reason: errorReason(i18n, failure, 'tokenizer.bankFailed') })}
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onShowError(rawMessage(failure))}>{t('detect.viewError')}</Button>
              {!settledBeforeFailure && <Button variant="outline" size="sm" className="h-7 px-2" disabled={!canRetry} onClick={onRetry}>{t('tokenizer.retry')}</Button>}
            </span>
          </AlertTitle>
        </Alert>
      )}
      {status === 'stopped' && <div><Button variant="outline" size="sm" disabled={!canRetry} onClick={onRetry}>{t('tokenizer.retry')}</Button></div>}
      {bank && run && run.steps.length > 0 && (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {verdict && top && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-meta text-muted-foreground">{t('tokenizer.topLabel')}</span>
                  <span className="text-section-title [overflow-wrap:anywhere]">{verdict.kind === 'unknown' ? t('tokenizer.unknownTitle') : series(top)}</span>
                  <span className="text-body text-muted-foreground">{verdict.kind === 'unknown' ? t('tokenizer.closest', { name: series(top) }) : top.lab_name}</span>
                </span>
                <span className="flex flex-col items-end gap-1 text-right">
                  <span className="text-section-title fp-mono">{percent(verdict.confidence)}</span>
                  <span className="text-meta text-muted-foreground">{t('tokenizer.probability')}</span>
                </span>
              </div>
            )}
            {verdict?.claim && phase === 'result' && config?.model && <ClaimAlert bank={bank} claim={verdict.claim} model={config.model} observed={verdict.kind === 'exact' ? verdict.top.id : undefined} />}
            {verdict && !verdict.claim && phase === 'result' && config?.model && <p className="text-body text-muted-foreground">{t('tokenizer.claimUnregistered', { model: config.model })}</p>}
            {run.baselineDrift && <Alert variant="warning" className="p-4"><TriangleAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.baselineDrift')}</AlertTitle></Alert>}
            <Candidates bank={bank} session={session} />
            {models.length > 0 && <p className="text-meta text-muted-foreground">{t('tokenizer.returnedModel', { models: models.join(', ') })}</p>}
          </div>
          <RequestLog bank={bank} steps={run.steps} onShowError={onShowError} />
        </div>
      )}
      {bank && verdict && phase === 'result' && (
        <div className="flex flex-col gap-2 text-body text-muted-foreground">
          {verdict.kind !== 'unknown' && top && (
            <details>
              <summary className="cursor-pointer">{t('tokenizer.members', { n: top.members.length })}</summary>
              <p className="fp-mono mt-2 text-meta [overflow-wrap:anywhere]">{top.members.join(' · ')}</p>
            </details>
          )}
          <Evidence bank={bank} session={session} verdict={verdict} />
          <details>
            <summary className="cursor-pointer">{t('tokenizer.limitsTitle')}</summary>
            <p className="mt-2">{t('tokenizer.limitsMethod')}</p>
            <p className="mt-2">{t('tokenizer.limitsDetail')}</p>
            <p className="mt-2">{t('tokenizer.limitsCounting')}</p>
            <p className="mt-2">{t('tokenizer.limitsFusion')}</p>
          </details>
        </div>
      )}
    </section>
  )
}
