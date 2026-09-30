import { useEffect, useState } from 'react'
import { motion, useMotionValueEvent, useSpring } from 'framer-motion'
import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PixelShader } from '@/components/pixel-shader'
import { toneClass, type Mode } from '@/components/sample-card'
import { ClaimAlert } from '@/components/tokenizer-claim'
import { useI18n } from '@/i18n'
import { brandLogos } from '@/lib/brand-logos'
import type { ResultTokenizer } from '@/lib/client'
import { errorReason } from '@/lib/errors'
import { listItem, listStagger, spring as motionSpring, useMotionPreset } from '@/lib/motion'
import { confidenceOf, NORMAL_CONFIDENCE_THRESHOLD } from '@/lib/result-confidence'
import { cn } from '@/lib/utils'
import type { TokenizerFit } from '@fingerpoint/shared/tokenizer-fusion'
import type { Analysis, CodedError } from '@fingerpoint/shared/types'

const fitTone: Record<TokenizerFit['status'], keyof typeof toneClass> = { consistent: 'success', inconsistent: 'destructive', uncertain: 'warning', unmapped: 'muted' }

function FitBadge({ fit }: { fit: TokenizerFit }) {
  const { t } = useI18n()
  return <Badge className={cn('h-[22px] rounded-[var(--radius-badge)] px-2 text-meta font-medium', toneClass[fitTone[fit.status]])}>{t(`tokenizer.fit.${fit.status}`)}</Badge>
}

/** Tokenizer evidence of a result: the probe it was fused with, or why none was available. */
export interface ResultEvidence { probe: ResultTokenizer | null; error: CodedError | null; model: string }

const VISIBLE = 8

export function AnimatedPercent({ value, className }: { value: number; className?: string }) {
  const { percent } = useI18n()
  const { reduced } = useMotionPreset()
  const spring = useSpring(reduced ? value : 0, motionSpring.gentle)
  const [shown, setShown] = useState(reduced ? value : 0)
  useEffect(() => { if (reduced) spring.jump(value); else spring.set(value) }, [spring, value, reduced])
  useMotionValueEvent(spring, 'change', v => setShown(v))
  return <span className={className} aria-label={percent(value)}>{percent(reduced ? value : Math.min(1, Math.max(0, shown)))}</span>
}

export function ConfidenceBar({ value }: { value: number | null }) {
  const { gentle, reduced } = useMotionPreset()
  return (
    <div className="fp-bar" aria-hidden="true">
      {value !== null && (
        <motion.span style={{ width: '100%', transformOrigin: 'left' }} initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: Math.min(1, Math.max(0, value)) }} transition={gentle} />
      )}
    </div>
  )
}

export function ResultPanel({ result, anomalous, mode, evidence, onReplacePrompts }: { result: Analysis; anomalous: number[]; mode: Mode; evidence: ResultEvidence | null; onReplacePrompts: () => void }) {
  const i18n = useI18n()
  const { t, percent } = i18n
  const [all, setAll] = useState(false)
  const { reduced } = useMotionPreset()
  const unscorable = result.decision === 'unscorable' || result.results.length === 0
  const top = result.results[0]
  const logo = top && brandLogos[top.family]
  const topConfidence = top ? confidenceOf(top) : null
  const lowConfidence = !unscorable && topConfidence !== null && topConfidence < NORMAL_CONFIDENCE_THRESHOLD
  const hasScores = result.results.some(r => confidenceOf(r) !== null)
  const rows = all ? result.results : result.results.slice(0, VISIBLE)
  const tokenizer = result.tokenizer
  const claim = tokenizer?.verdict?.claim
  // The tokenizer moved another candidate to the top, or could not be fused and contradicts the leader.
  const displaced = !unscorable && tokenizer?.fused && tokenizer.fingerprint_top !== result.prediction
    ? result.results.find(row => row.model === tokenizer.fingerprint_top) : undefined
  const contradicted = !unscorable && tokenizer && !tokenizer.fused && top?.tokenizer?.status === 'inconsistent'

  return (
    <section className="flex flex-col gap-6" aria-labelledby="result-title">
      <h2 id="result-title" className="text-section-title">{t('detect.result')}</h2>
      <div className="fp-card flex flex-col gap-1 overflow-hidden p-4">
        {unscorable ? (
          <>
            <span className="text-meta text-muted-foreground">{t('detect.result')}</span>
            <span className="text-display">{t('detect.unscorable')}</span>
            <span className="text-body text-muted-foreground">{t('detect.unscorableBody', { used: result.used_outputs })}</span>
            <PixelShader effect="static" className="mt-3 h-16 w-full rounded-lg text-muted-foreground/40" />
          </>
        ) : (
          <div className="fp-result-summary">
            <div className="flex min-w-0 flex-col-reverse items-start gap-2 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-muted-foreground">{t('detect.topLabel')}</span>
                <span className="text-display [overflow-wrap:anywhere]">{top.display_name}</span>
                {(top.family_name || top.tokenizer) && <span className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
                  {top.family_name}
                  {top.tokenizer && <FitBadge fit={top.tokenizer} />}
                </span>}
              </div>
              {logo && <PixelShader effect="logo" image={logo} className="size-12 shrink-0 text-foreground sm:size-18" />}
            </div>
            <div className="fp-result-score flex flex-col items-end gap-1 text-right">
              {topConfidence === null
                ? <span className="text-body text-muted-foreground">{t('detect.scoreUnavailable')}</span>
                : <AnimatedPercent value={topConfidence} className="text-display-number" />}
              <span className="text-meta text-muted-foreground">{t('detect.scoreLabel')}</span>
              <span className="text-meta text-muted-foreground">
                {t('detect.resultSourceBefore')}<span className="fp-mono">lm.ikale.io</span>{t('detect.resultSourceAfter')}
              </span>
            </div>
          </div>
        )}
      </div>
      {anomalous.length > 0 && (
        <Alert variant="warning" className="p-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t('detect.anomalousSamples', { samples: anomalous.map(i => i + 1).join(', ') })}</AlertTitle>
          <AlertDescription>{t('detect.anomalousHelp')}</AlertDescription>
          <div className="col-start-2 mt-3">
            <Button variant="outline" size="sm" onClick={onReplacePrompts}>{t(mode === 'api' ? 'detect.anomalousReplace' : 'detect.anomalousReplaceManual')}</Button>
          </div>
        </Alert>
      )}
      {lowConfidence && (
        <Alert variant="warning" className="p-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t('detect.lowConfidence')}</AlertTitle>
        </Alert>
      )}
      {(displaced || contradicted) && (
        <Alert variant="warning" className="p-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{displaced
            ? t(displaced.tokenizer?.status === 'inconsistent' ? 'tokenizer.changedLeader' : 'tokenizer.changedLeaderNeutral', { fingerprint: displaced.display_name, top: top.display_name })
            : t('tokenizer.leaderInconsistent', { top: top.display_name })}</AlertTitle>
        </Alert>
      )}
      {claim?.status === 'inconsistent' && evidence?.model && <ClaimAlert bank={evidence.probe?.bank ?? null} claim={claim} model={evidence.model} observed={tokenizer?.verdict?.kind === 'exact' ? tokenizer.verdict.top.id : undefined} />}
      {!unscorable && <p className="text-body text-muted-foreground">{result.used_outputs < 3 ? t('detect.partialNote', { n: result.used_outputs }) : t(tokenizer?.fused ? 'detect.rankingNoteFused' : 'detect.rankingNote')}</p>}
      {!unscorable && !tokenizer && evidence?.error && <p className="text-body text-muted-foreground">{t('tokenizer.unavailableResult', { reason: errorReason(i18n, evidence.error, 'tokenizer.bankFailed') })}</p>}
      {!unscorable && (
        <motion.ol className="fp-card px-4" variants={reduced ? undefined : listStagger} initial={reduced ? false : 'hidden'} animate="show" aria-label={t('detect.result')}>
          {rows.map((r, i) => {
            const v = confidenceOf(r)
            return (
              <motion.li key={r.model} className="fp-result-row text-body" data-unscored={!hasScores || undefined} variants={!reduced && i < VISIBLE ? listItem : undefined}>
                <span className="text-muted-foreground">{i + 1}</span>
                <span className="fp-result-name min-w-0 break-words font-medium">{r.display_name}</span>
                <span className="fp-result-family truncate text-muted-foreground">{r.family_name}</span>
                {hasScores && <>
                  <ConfidenceBar value={v} />
                  <span className="fp-result-percent text-right" aria-label={t('detect.confidence')}>{v === null ? '—' : percent(v)}</span>
                </>}
              </motion.li>
            )
          })}
          {result.results.length > VISIBLE && (
            <li className="flex h-12 items-center border-t border-border">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-primary hover:text-primary" onClick={() => setAll(a => !a)} aria-expanded={all}>
                {all ? t('detect.showLess') : t('detect.showAll', { n: result.results.length })}
              </Button>
            </li>
          )}
        </motion.ol>
      )}
      <div className="flex flex-col gap-2 text-body text-muted-foreground">
        <p>{t('detect.disclaimer')}</p>
        <details>
          <summary className="cursor-pointer">{t('detect.limitsTitle')}</summary>
          <p className="mt-2">{t('detect.limitsDetail')}</p>
          <p className="mt-2">{t('detect.limitsExamples')}</p>
        </details>
      </div>
    </section>
  )
}
