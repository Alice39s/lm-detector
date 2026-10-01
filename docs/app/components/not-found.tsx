import { Link, useLocation } from 'react-router'
import { SiteHeader } from '@/components/site-header'
import { siteText } from '@/lib/layout.shared'
import { docsBase } from '@/lib/shared'
import { localeOf, localizedUrl } from '@/lib/urls'

const homeUrl = localizedUrl(docsBase)

export function NotFound() {
  const locale = localeOf(useLocation().pathname, docsBase)
  return (
    <>
      <SiteHeader locale={locale} />
      <title>{`404 · ${siteText[locale].brandLine}`}</title>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
        <h1 className="text-h1">{siteText[locale].notFound}</h1>
        <Link className="inline-flex h-9 items-center rounded-lg bg-fd-primary px-3 text-sm font-medium text-fd-primary-foreground hover:bg-fd-primary/80" to={homeUrl([], locale)}>
          {siteText[locale].backToDocs}
        </Link>
      </main>
    </>
  )
}
