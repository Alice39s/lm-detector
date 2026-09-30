import { useMemo } from 'react'
import { CircleCheck, OctagonAlert, TriangleAlert } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { useI18n, type MessageKey } from '@/i18n'
import type { TokenizerBank, TokenizerClass } from '@fingerpoint/shared/tokenizer-bank'
import type { ClaimCheck } from '@fingerpoint/shared/tokenizer-posterior'

/** Classes whose counts a relay can also produce by estimating usage with tiktoken. */
const estimatedUsageClasses = new Set(['o200k', 'cl100k'])
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

/** Consistency of the observed tokenizer with the model filled in the API configuration. */
export function ClaimAlert({ bank, claim, model, observed }: { bank: TokenizerBank | null; claim: ClaimCheck; model: string; observed?: string }) {
  const { t } = useI18n()
  const { name } = useTokenizerNames(bank)
  const expected = claim.expected.length ? claim.expected.map(name).join(' / ') : t('tokenizer.unpublished', { vendor: claim.vendor })
  if (claim.status === 'consistent') {
    return <Alert className="p-4 *:[svg]:text-success"><CircleCheck aria-hidden="true" /><AlertTitle>{t('tokenizer.claimConsistent', { model, expected })}</AlertTitle></Alert>
  }
  if (claim.status === 'inconsistent') {
    return <Alert variant="destructive" className="p-4"><OctagonAlert aria-hidden="true" /><AlertTitle>
      {t('tokenizer.claimInconsistent', { model, expected })}
      {observed && estimatedUsageClasses.has(observed) && <span className="mt-1 block font-normal">{t('tokenizer.estimatedUsage')}</span>}
    </AlertTitle></Alert>
  }
  return <Alert variant="warning" className="p-4"><TriangleAlert aria-hidden="true" /><AlertTitle>{t('tokenizer.claimUncertain', { model, expected })}</AlertTitle></Alert>
}
