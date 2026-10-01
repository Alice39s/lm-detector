import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { Link, useLocation } from 'react-router'
import { baseOptions, siteText } from '@/lib/layout.shared'
import { docsBase } from '@/lib/shared'
import { localeOf, localizedUrl } from '@/lib/urls'

const homeUrl = localizedUrl(docsBase)

export function NotFound() {
  const locale = localeOf(useLocation().pathname, docsBase)
  return (
    <HomeLayout {...baseOptions(locale)}>
      <title>{`404 · ${siteText[locale].brandLine}`}</title>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
        <h1 className="text-xl font-semibold">{siteText[locale].notFound}</h1>
        <Link className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground" to={homeUrl([], locale)}>
          {siteText[locale].backToDocs}
        </Link>
      </div>
    </HomeLayout>
  )
}
