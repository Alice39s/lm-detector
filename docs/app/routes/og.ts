import { generateOGImage } from 'fumadocs-ui/og/takumi'
import type { Route } from './+types/og'
import { ogRenderer } from '@/lib/og.server'
import { docsBase } from '@/lib/shared'
import { source } from '@/lib/source'
import { localeOf } from '@/lib/urls'

/** The preview image of a page at `<page>/image.png`, pre-rendered at build time with the detector's colors. */
export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = localeOf(new URL(request.url).pathname, docsBase)
  const slugs = params['*'].split('/').filter(segment => segment.length > 0)
  if (slugs.pop() !== 'image.png') throw new Response('Not found', { status: 404 })
  const page = source.getPage(slugs, locale)
  if (!page) throw new Response('Not found', { status: 404 })
  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: 'Fingerpoint Detector',
    primaryColor: 'rgba(56, 118, 222, 0.45)',
    primaryTextColor: 'rgb(120, 170, 255)',
    renderer: await ogRenderer(),
    fontFamilies: ['Geist', 'Noto Sans SC'],
    format: 'png',
  })
}
