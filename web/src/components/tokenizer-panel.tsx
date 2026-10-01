import { useMemo, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Check, ChevronDown, CircleStop, Loader2, MoreVertical, OctagonAlert, TriangleAlert, X } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PixelShader } from '@/components/pixel-shader'
import { ConfidenceBar } from '@/components/result-panel'
import { toneClass } from '@/components/sample-card'
import { ModelCheck, useTokenizerNames } from '@/components/tokenizer-claim'
import { useI18n } from '@/i18n'
import { errorReason, rawMessage } from '@/lib/errors'
import { listItem, listStagger, useMotionPreset } from '@/lib/motion'
import type { TokenizerSession } from '@/lib/use-tokenizer-probe'
import { cn } from '@/lib/utils'
import type { CodedError } from '@fingerpoint/shared/types'
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

/** More actions of the card and the details header. */
function MoreMenu({ failure, onShowError, onRetry, retryDisabled }: { failure: CodedError | null; onShowError: (detail: string) => void; onRetry: () => void; retryDisabled: boolean }) {
  const { t } = useI18n()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={t('detect.more')} />}><MoreVertical /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {failure && <DropdownMenuItem onClick={() => onShowError(rawMessage(failure))}>{t('detect.viewError')}</DropdownMenuItem>}
          <DropdownMenuItem disabled={retryDisabled} onClick={onRetry}>{t('tokenizer.retry')}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Separator under a header; while probing it carries the `march` pixel effect, like a sampling sample card. */
function HeaderRule({ busy }: { busy: boolean }) {
  return (
    <div className="relative h-px bg-border">
      {busy && <PixelShader effect="march" cell={2} className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 text-muted-foreground/60" />}
    </div>
  )
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
    return <>{t('tokenizer.stoppedNoVerdict')}</>
  }
  const top = byId.get(verdict.top.id) as TokenizerClass
  const label = verdict.kind === 'exact' ? `${series(top)} · ${top.lab_name}` : `${t('tokenizer.unknownTitle')} · ${t('tokenizer.closest', { name: series(top) })}`
  return <>{t(session.phase === 'result' ? 'tokenizer.settled' : 'tokenizer.leading', { name: label, p: percent(verdict.confidence) })}</>
}

/** Status of the probe beside the three sample cards while sampling. */
export function TokenizerCard({ session, onShowError, onRetry, canRetry }: { session: TokenizerSession; onShowError: (detail: string) => void; onRetry: () => void; canRetry: boolean }) {
  const { t } = useI18n()
  const verdict = useVerdict(session)
  const status = statusOf(session, verdict)
  const failure = failureOf(session)
  const busy = status === 'probing'
  return (
    <section className="fp-card flex min-w-0 flex-col gap-3 p-4" aria-labelledby="tokenizer-card-title" aria-busy={busy}>
      <div className="flex h-9 items-center justify-between gap-2">
        <h2 id="tokenizer-card-title" className="text-card-title">{t('tokenizer.title')}</h2>
        <div className="flex items-center gap-1">
          <StatusBadge status={status} />
          <MoreMenu failure={failure} onShowError={onShowError} onRetry={onRetry} retryDisabled={busy || !canRetry} />
        </div>
      </div>
      <HeaderRule busy={busy} />
      <p className={cn('text-body', failure && !verdict && 'text-destructive')} role="status"><SummaryLine session={session} verdict={verdict} /></p>
      <p className="text-meta text-muted-foreground">
        {t('tokenizer.requestCount', { n: session.run?.steps.length ?? 0 })} · {t('tokenizer.help')}
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
  const detail = verdict?.kind === 'exact' ? name(verdict.top.id)
    : verdict ? t('tokenizer.closest', { name: name(verdict.top.id) })
    : t(status === 'probing' ? 'tokenizer.state.probing' : status === 'stopped' ? 'tokenizer.state.stopped' : 'tokenizer.state.failed')
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

/** Header row shared by the candidate list and the request log, so both lists start on one line. */
function ListHeader({ id, label, count }: { id: string; label: string; count: ReactNode }) {
  return (
    <div className="flex h-11 items-center justify-between gap-2 border-b border-border">
      <h3 id={id} className="text-body font-medium">{label}</h3>
      <span className="text-meta text-muted-foreground">{count}</span>
    </div>
  )
}

/** Column A: the verdict on three lines that share their type roles with column B. */
function Summary({ bank, verdict, settled, busy }: { bank: TokenizerBank; verdict: TokenizerVerdict | null; settled: boolean; busy: boolean }) {
  const { t, percent } = useI18n()
  const { byId, series } = useTokenizerNames(bank)
  const top = verdict ? byId.get(verdict.top.id) : undefined
  const title = !verdict || !top ? t('tokenizer.pendingTitle') : verdict.kind === 'exact' ? series(top) : t('tokenizer.unknownTitle')
  const detail = !verdict || !top ? t(busy ? 'tokenizer.pendingProbing' : 'tokenizer.pendingNone')
    : verdict.kind === 'exact' ? top.lab_name : t('tokenizer.closest', { name: series(top) })
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] content-start gap-x-4 gap-y-1">
      <p className="text-meta text-muted-foreground">{t(settled ? 'tokenizer.topLabel' : 'tokenizer.leadingLabel')}</p>
      <p className="text-right text-meta text-muted-foreground">{t('tokenizer.probability')}</p>
      <p className="text-section-title [overflow-wrap:anywhere]">{title}</p>
      <p className="fp-mono text-right text-section-title">{verdict ? percent(verdict.confidence) : '—'}</p>
      <p className="text-body text-muted-foreground [overflow-wrap:anywhere]">{detail}</p>
    </div>
  )
}

/** Column C: the leading classes and the unlisted hypothesis, on the result-row grid. */
function Candidates({ bank, session }: { bank: TokenizerBank; session: TokenizerSession }) {
  const { t, percent } = useI18n()
  const { smooth, reduced } = useMotionPreset()
  const { byId, series } = useTokenizerNames(bank)
  const posterior = session.run?.posterior
  return (
    <section className="flex min-w-0 flex-col" aria-labelledby="tokenizer-candidates">
      <ListHeader id="tokenizer-candidates" label={t('tokenizer.candidates')} count={t('tokenizer.candidateCount', { n: VISIBLE, total: bank.classes.length })} />
      {posterior ? (
        <motion.ol className="fp-custom-tokenizer-candidates" variants={reduced ? undefined : listStagger} initial={reduced ? false : 'hidden'} animate="show" aria-labelledby="tokenizer-candidates">
          {posterior.classes.slice(0, VISIBLE).map((score, i) => {
            const item = byId.get(score.id) as TokenizerClass
            return (
              <motion.li key={score.id} layout={reduced ? false : 'position'} transition={smooth} className="fp-result-row text-body lg:h-12" variants={reduced ? undefined : listItem}>
                <span className="text-muted-foreground">{i + 1}</span>
                <span className="fp-result-name min-w-0 font-medium lg:truncate" title={series(item)}>{series(item)}</span>
                <span className="fp-result-family truncate text-muted-foreground" title={item.lab_name}>{item.lab_name}</span>
                <ConfidenceBar value={score.exact} />
                <span className="fp-result-percent fp-mono text-right">{percent(score.exact)}</span>
              </motion.li>
            )
          })}
          <li className="fp-result-row text-body lg:h-12">
            <span className="text-muted-foreground">—</span>
            <span className="fp-result-name min-w-0 font-medium lg:truncate">{t('tokenizer.unknownTitle')}</span>
            <span className="fp-result-family truncate text-muted-foreground" />
            <ConfidenceBar value={posterior.unknown} />
            <span className="fp-result-percent fp-mono text-right">{percent(posterior.unknown)}</span>
          </li>
        </motion.ol>
      ) : <p className="flex h-12 items-center text-body text-muted-foreground">{t('tokenizer.candidatesPending')}</p>}
    </section>
  )
}

/** Column D: every request in order. On wide screens it scrolls inside the height of the seven candidate rows. */
function RequestLog({ bank, steps, onShowError }: { bank: TokenizerBank; steps: ProbeStep[]; onShowError: (detail: string) => void }) {
  const { t, number } = useI18n()
  const baseline = steps.find(step => step.probe === null && step.tokens !== undefined)?.tokens
  return (
    <section className="flex min-w-0 flex-col" aria-labelledby="tokenizer-requests">
      <ListHeader id="tokenizer-requests" label={t('tokenizer.requests')} count={t('tokenizer.requestCount', { n: steps.length })} />
      <ol className="flex flex-col lg:max-h-[21rem] lg:overflow-y-auto" tabIndex={0} aria-labelledby="tokenizer-requests">
        {steps.map((step, index) => {
          const stopped = step.errorCode === 'aborted'
          const delta = step.tokens !== undefined && baseline !== undefined && step.probe !== null ? step.tokens - baseline : undefined
          return (
            <li key={`${index}:${step.probe}`} className="grid h-12 shrink-0 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border text-body first:border-t-0">
              {step.state === 'requesting' ? <Loader2 className="size-4 animate-spin text-warning" aria-label={t('detect.state.requesting')} />
                : step.state === 'done' ? <Check className="size-4 text-success" aria-hidden="true" />
                : <X className={cn('size-4', stopped ? 'text-muted-foreground' : 'text-destructive')} aria-hidden="true" />}
              <ProbeLabel bank={bank} step={step} />
              {step.state === 'failed'
                ? stopped ? <span className="text-meta text-muted-foreground">{t('tokenizer.state.stopped')}</span>
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

function Evidence({ bank, session, verdict }: { bank: TokenizerBank; session: TokenizerSession; verdict: TokenizerVerdict }) {
  const { t, number } = useI18n()
  const { byId, series } = useTokenizerNames(bank)
  const top = byId.get(verdict.top.id) as TokenizerClass
  const index = new Map(bank.probes.map((probe, j) => [probe.id, j]))
  const rows = (session.run?.observations ?? []).filter(observation => observation.probe !== null)
  return (
    <details>
      <summary className="cursor-pointer">{t('tokenizer.evidence')}</summary>
      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-left">{t('tokenizer.colProbe')}</TableHead>
              <TableHead className="text-right">{t('tokenizer.colObserved')}</TableHead>
              <TableHead className="text-right">{t('tokenizer.colExpected', { name: series(top) })}</TableHead>
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
                  <TableCell className="max-w-[18rem] text-left"><ProbeLabel bank={bank} step={{ probe: observation.probe, state: 'done' }} /></TableCell>
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

/** Run-level notices between the header and the grid: a failure, a stop, or baselines that disagree. */
function Notices({ session, verdict }: { session: TokenizerSession; verdict: TokenizerVerdict | null }) {
  const i18n = useI18n()
  const { t } = i18n
  const { run } = session
  const failure = failureOf(session)
  // The closing baseline runs after the posterior settled; its failure leaves the verdict intact.
  const settledBeforeFailure = Boolean(run?.verdict && run.posterior && probingDone(run.posterior))
  const stopped = !failure && session.phase === 'result' && run?.error?.code === 'aborted'
  return <>
    {failure && (settledBeforeFailure
      ? <Alert variant="warning" className="p-4"><TriangleAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.baselineCheckFailed', { reason: errorReason(i18n, failure) })}</AlertTitle></Alert>
      : <Alert variant="destructive" className="p-4"><OctagonAlert aria-hidden="true" /><AlertTitle>
          {run?.verdict ? t('tokenizer.stoppedEarly', { reason: errorReason(i18n, failure) }) : t('tokenizer.unavailable', { reason: errorReason(i18n, failure, 'tokenizer.bankFailed') })}
        </AlertTitle></Alert>)}
    {stopped && <Alert className="p-4 text-muted-foreground"><CircleStop aria-hidden="true" /><AlertTitle className="font-normal">
      {verdict ? t('tokenizer.stoppedPartial', { n: run?.posterior?.answered ?? 0 }) : t('tokenizer.stoppedNoVerdict')}
    </AlertTitle></Alert>}
    {run?.baselineDrift && <Alert variant="warning" className="p-4"><TriangleAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.baselineDrift')}</AlertTitle></Alert>}
  </>
}

/** Probe details, opened from the sample strip after sampling. */
export function TokenizerDetails({ session, onShowError, onCollapse, onRetry, canRetry }: {
  session: TokenizerSession; onShowError: (detail: string) => void; onCollapse: () => void; onRetry: () => void; canRetry: boolean
}) {
  const { t } = useI18n()
  const { bank, run, phase, config } = session
  const verdict = useVerdict(session)
  const status = statusOf(session, verdict)
  const busy = status === 'probing'
  const settled = phase === 'result'
  const { byId } = useTokenizerNames(bank)
  const failure = failureOf(session)
  const steps = run?.steps ?? []
  const models = [...new Set((run?.observations ?? []).map(observation => observation.responseModel).filter((model): model is string => Boolean(model)))]
  const top = verdict ? byId.get(verdict.top.id) : undefined
  const seconds = settled && session.finishedAt > 0 ? ((session.finishedAt - session.startedAt) / 1000).toFixed(1) : null
  return (
    <section id="tokenizer-panel" className="fp-card flex min-w-0 flex-col gap-3 p-4" aria-labelledby="tokenizer-details-title" aria-busy={busy}>
      <div className="flex flex-col gap-1">
        <div className="flex h-9 items-center justify-between gap-2">
          <h2 id="tokenizer-details-title" className="text-card-title">{t('tokenizer.title')}</h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onCollapse} aria-label={`${t('detect.collapse')} ${t('tokenizer.title')}`}>
              {t('detect.collapse')}<ChevronDown data-icon="inline-end" className="rotate-180" />
            </Button>
            <StatusBadge status={status} />
            <MoreMenu failure={failure} onShowError={onShowError} onRetry={onRetry} retryDisabled={busy || !canRetry} />
          </div>
        </div>
        <p className="text-meta text-muted-foreground">{t('tokenizer.help')}</p>
      </div>
      <HeaderRule busy={busy} />
      <Notices session={session} verdict={verdict} />
      {bank && run && steps.length > 0 && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Summary bank={bank} verdict={verdict} settled={settled} busy={busy} />
          <ModelCheck bank={bank} verdict={verdict} model={config?.model ?? ''} settled={settled} models={models} />
          <Candidates bank={bank} session={session} />
          <RequestLog bank={bank} steps={steps} onShowError={onShowError} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
        <span>
          {t('tokenizer.requestCount', { n: steps.length })}
          {seconds !== null && ` · ${t('detect.seconds', { s: seconds })}`}
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-primary hover:text-primary" disabled={busy || !canRetry} onClick={onRetry}>{t('tokenizer.retry')}</Button>
      </div>
      {bank && verdict && settled && (
        <div className="flex flex-col gap-2 text-body text-muted-foreground">
          {verdict.kind === 'exact' && top && (
            <details>
              <summary className="cursor-pointer">{t('tokenizer.members', { n: top.members.length })}</summary>
              <p className="fp-mono mt-2 text-meta [overflow-wrap:anywhere]">{top.members.join(' · ')}</p>
            </details>
          )}
          <Evidence bank={bank} session={session} verdict={verdict} />
          <details>
            <summary className="cursor-pointer">{t('tokenizer.limitsTitle')}</summary>
            <p className="mt-2">{t('tokenizer.limitsMethod')}</p>
            <p className="mt-2">{t('tokenizer.limitsIdentity')}</p>
            <p className="mt-2">{t('tokenizer.limitsEstimate')}</p>
            <p className="mt-2">{t('tokenizer.limitsReference')}</p>
          </details>
        </div>
      )}
    </section>
  )
}
