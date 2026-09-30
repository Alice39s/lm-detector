import type { Locale } from '@/i18n'

/**
 * A link into the docs, which the build publishes at `docs/` next to the detector. The path stays relative, so a
 * deployment under a sub-path (such as a GitHub Pages project site) reaches its own copy.
 */
export function docsHref(locale: Locale, page = '') {
  return `docs/${locale === 'en' ? 'en/' : ''}${page}`
}
