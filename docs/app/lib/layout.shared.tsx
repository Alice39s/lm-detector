import { zhCN } from '@fumadocs/language/zh-cn'
import { openapiTranslations } from 'fumadocs-openapi/i18n'
import { uiTranslations } from 'fumadocs-ui/i18n'
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { ScanSearch } from 'lucide-react'
import { i18n, type Locale } from './i18n'
import { appUrl, docsBase, repositoryUrl } from './shared'
import { localizedUrl } from './urls'

const homeUrl = localizedUrl(docsBase)

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .extend(openapiTranslations())
  .preset('zh', zhCN())
  .add({ en: { displayName: 'English' } })

/** Words the docs chrome needs beyond Fumadocs' own translations. */
export const siteText = {
  zh: { detector: '在线检测', brandLine: '文档', notFound: '这个页面不存在', backToDocs: '返回文档首页' },
  en: { detector: 'Detector', brandLine: 'Docs', notFound: 'This page does not exist', backToDocs: 'Back to the docs' },
} satisfies Record<Locale, Record<string, string>>

/** The brand mark of the detector's header, so both sites read as one product. */
function Brand({ locale }: { locale: Locale }) {
  return (
    <span className="fd-brand">
      <span className="fd-brand-title">Fingerpoint Detector</span>
      <span className="fd-brand-byline">{siteText[locale].brandLine}</span>
    </span>
  )
}

export function baseOptions(locale: Locale): BaseLayoutProps {
  return {
    nav: { title: <Brand locale={locale} />, url: homeUrl([], locale) },
    githubUrl: repositoryUrl,
    links: [
      {
        // A plain anchor: the detector is another app, outside the docs router.
        type: 'custom',
        children: (
          <a href={appUrl} className="fd-app-link">
            <ScanSearch aria-hidden="true" />
            {siteText[locale].detector}
          </a>
        ),
      },
    ],
  }
}
