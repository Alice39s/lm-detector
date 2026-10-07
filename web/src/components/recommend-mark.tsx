import type { ReactNode } from 'react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * The small tag beside a recommended option or value, reading "Recommended" unless `children` gives a reason.
 * Its text is part of the accessible name.
 */
export function RecommendMark({ className, children }: { className?: string; children?: ReactNode }) {
  const { t } = useI18n()
  return <span className={cn('fp-recommend', className)}>{children ?? t('app.recommended')}</span>
}
