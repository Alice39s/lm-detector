import { brandLogos } from '@/lib/brand-logos'
import { cn } from '@/lib/utils'

/** A brand logo from `lib/brand-logos.ts` as a 16px inline icon; currentColor parts follow the text colour. */
export function BrandIcon({ family, className }: { family: keyof typeof brandLogos; className?: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="inline-start" className={cn('size-4 shrink-0', className)} dangerouslySetInnerHTML={{ __html: brandLogos[family] }} />
}
