import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb'
import type { Route } from './+types/og'
import { siteText } from '@/lib/layout.shared'
import { ogResponse } from '@/lib/og-response'
import { docsBase, siteOrigin } from '@/lib/shared'
import { source } from '@/lib/source'
import { localeOf } from '@/lib/urls'

const languageTags = { zh: 'zh-Hans', en: 'en' }

/** The preview image of a page at `/docs/og/<page>/image.png` (`/docs/en/og/…` in English), pre-rendered at build time. */
export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = localeOf(new URL(request.url).pathname, docsBase)
  const slugs = params['*'].split('/').filter(segment => segment.length > 0)
  if (slugs.pop() !== 'image.png') throw new Response('Not found', { status: 404 })
  const page = source.getPage(slugs, locale)
  if (!page) throw new Response('Not found', { status: 404 })
  const folders = getBreadcrumbItems(page.url, source.getPageTree(locale)).map(item => {
    if (typeof item.name !== 'string') throw new Error(`A folder above ${page.url} has a name that is not text`)
    return item.name
  })
  // A folder's index page usually carries the folder's name, which the title already shows.
  if (folders.at(-1) === page.data.title) folders.pop()
  return ogResponse({
    title: page.data.title,
    description: page.data.description || null,
    section: folders.length ? folders.join(' / ') : null,
    byline: siteText[locale].brandLine,
    host: new URL(siteOrigin).host,
  }, languageTags[locale])
}
