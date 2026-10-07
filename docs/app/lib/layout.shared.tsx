import { zhCN } from '@fumadocs/language/zh-cn'
import { openapiTranslations } from 'fumadocs-openapi/i18n'
import { uiTranslations } from 'fumadocs-ui/i18n'
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { i18n, type Locale } from './i18n'

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .extend(openapiTranslations())
  .preset('zh', zhCN())
  .add({ en: { displayName: 'English' } })

/** Words the docs chrome needs beyond Fumadocs' own translations; the header's match the detector's. */
export const siteText = {
  zh: {
    brandLine: '文档',
    navigation: '主导航',
    detect: '检测',
    library: '样本库',
    docs: '文档',
    repository: 'GitHub 仓库：Ikaleio/lm-detector',
    star: '在 GitHub 上为 Ikaleio/lm-detector 点 Star',
    toggleLanguage: 'Switch to English',
    theme: '主题',
    toggleTheme: '切换主题，当前：{theme}',
    themeLight: '浅色',
    themeDark: '深色',
    themeSystem: '跟随系统',
    pages: '目录',
    notFound: '这个页面不存在',
    backToDocs: '返回文档首页',
  },
  en: {
    brandLine: 'Docs',
    navigation: 'Main navigation',
    detect: 'Detect',
    library: 'Library',
    docs: 'Docs',
    repository: 'GitHub repository: Ikaleio/lm-detector',
    star: 'Star Ikaleio/lm-detector on GitHub',
    toggleLanguage: '切换到中文',
    theme: 'Theme',
    toggleTheme: 'Change theme, current: {theme}',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',
    pages: 'Pages',
    notFound: 'This page does not exist',
    backToDocs: 'Back to the docs',
  },
} satisfies Record<Locale, Record<string, string>>

/**
 * The site header carries the brand, the language and theme controls and the repository link, so the sidebar keeps
 * only search and the page tree.
 */
export const layoutOptions: BaseLayoutProps = {
  nav: { title: () => null },
  i18n: false,
  themeSwitch: { enabled: false },
}
