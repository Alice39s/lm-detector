import { useMemo } from 'react'
import { CircleCheck, CircleHelp, Clock, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useI18n, type MessageKey } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TokenizerBank, TokenizerClass } from '@fingerpoint/shared/tokenizer-bank'
import type { TokenizerVerdict } from '@fingerpoint/shared/tokenizer-posterior'

/** Classes whose counts a relay can also produce by estimating usage with tiktoken. */
const estimatedUsageClasses: Record<string, true> = { o200k: true, cl100k: true }
const categories = ['ascii', 'punctuation', 'whitespace', 'digits', 'emoji', 'cjk', 'cjk_rare', 'code', 'latin_ext', 'latin', 'cyrillic', 'arabic', 'devanagari', 'thai', 'hebrew', 'korean', 'japanese', 'greek', 'bytes', 'math', 'structured', 'prose', 'armenian', 'georgian', 'indic', 'sea', 'other_script', 'symbol', 'repeat'] as const

export function useTokenizerNames(bank: TokenizerBank | null) {
  const { locale, t } = useI18n()
  return useMemo(() => {
    const byId = new Map((bank?.classes ?? []).map(item => [item.id, item]))
    const series = (item: TokenizerClass) => locale === 'zh' ? item.series_zh : item.series
    const name = (id: string) => { const item = byId.get(id); return item ? series(item) : id }
    const category = (value: string) => (categories as readonly string[]).includes(value) ? t(`tokenizer.category.${value}` as MessageKey) : value
    return { byId, series, name, category }
  }, [bank, locale, t])
}

type Check = { icon: LucideIcon; tone: string; text: string }

/**
 * Column B of the tokenizer details: the model the user entered and whether its tokenizer agrees with the measured one.
 * The three lines share the type roles of the summary in column A, so the two columns keep one baseline grid.
 */
export function ModelCheck({ bank, verdict, model, settled, models }: {
  bank: TokenizerBank | null; verdict: TokenizerVerdict | null; model: string; settled: boolean; models: string[]
}) {
  const { t } = useI18n()
  const { name } = useTokenizerNames(bank)
  const claim = settled ? verdict?.claim ?? null : null
  const expected = claim ? claim.expected.length ? claim.expected.map(name).join(' / ') : t('tokenizer.unpublished', { vendor: claim.vendor }) : ''
  const check: Check = !settled || !verdict
    ? { icon: Clock, tone: 'text-muted-foreground', text: t(settled ? 'tokenizer.claimNoVerdict' : 'tokenizer.claimPending') }
    : !claim ? { icon: CircleHelp, tone: 'text-muted-foreground', text: t('tokenizer.claimUnregistered') }
    : claim.status === 'consistent' ? { icon: CircleCheck, tone: 'text-success', text: t('tokenizer.claimConsistent', { expected }) }
    : claim.status === 'inconsistent' ? { icon: OctagonAlert, tone: 'text-destructive', text: t('tokenizer.claimInconsistent', { expected }) }
    : { icon: TriangleAlert, tone: 'text-warning', text: t('tokenizer.claimUncertain', { expected }) }
  const muted = check.tone === 'text-muted-foreground'
  const estimated = claim?.status === 'inconsistent' && verdict?.kind === 'exact' && estimatedUsageClasses[verdict.top.id] === true
  const Icon = check.icon
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-meta text-muted-foreground">{t('tokenizer.modelLabel')}</p>
      <p className="fp-mono text-section-title [overflow-wrap:anywhere]">{model}</p>
      <p className={cn('flex items-start gap-2 text-body', muted && 'text-muted-foreground')} role="status">
        <Icon className={cn('mt-0.5 size-4 shrink-0', check.tone)} aria-hidden="true" />
        <span className="min-w-0">{check.text}</span>
      </p>
      {estimated && <p className="text-meta text-muted-foreground">{t('tokenizer.estimatedUsage')}</p>}
      {models.length > 0 && <p className="text-meta text-muted-foreground [overflow-wrap:anywhere]">{t('tokenizer.returnedModel', { models: models.join(', ') })}</p>}
    </div>
  )
}
