import { defineI18n } from 'fumadocs-core/i18n'

/**
 * Chinese is the primary language, as for the detector. A page without an English file (`page.en.mdx`) falls back
 * to the Chinese page, so an unfinished translation never produces a missing link.
 */
export const i18n = defineI18n({
  defaultLanguage: 'zh',
  languages: ['zh', 'en'],
  hideLocale: 'default-locale',
  parser: 'dot',
})

export type Locale = (typeof i18n.languages)[number]
