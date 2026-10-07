import type { Locale } from '@/i18n'

/**
 * A link into the docs, which the build publishes at `docs/` next to the detector. The path stays relative, so a
 * deployment under a sub-path (such as a GitHub Pages project site) reaches its own copy. The docs exist in Chinese
 * and English only: both Chinese scripts open the Chinese docs, every other locale opens the English ones.
 */
export function docsHref(locale: Locale, page = '') {
  return `docs/${locale.startsWith('zh') ? '' : 'en/'}${page}`
}
