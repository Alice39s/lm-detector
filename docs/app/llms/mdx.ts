import type { Route } from './+types/mdx'
import { docsBase } from '@/lib/shared'
import { docsLlms, source } from '@/lib/source'
import { localeOf } from '@/lib/urls'

/** The Markdown twin of one page at `<page>/content.md`, for "Copy Markdown" and LLM tools. */
export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = localeOf(new URL(request.url).pathname, docsBase)
  const slugs = params['*'].split('/').filter(segment => segment.length > 0)
  if (slugs.pop() !== 'content.md') return new Response('Not found', { status: 404 })
  const page = source.getPage(slugs, locale)
  if (!page) return new Response('Not found', { status: 404 })
  return new Response(await docsLlms.page(page), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
}
