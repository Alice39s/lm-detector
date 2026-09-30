import type { ComponentProps } from 'react'
import { Card } from 'fumadocs-ui/components/card'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { source, type DocsPage } from '@/lib/source'

const Anchor = defaultMdxComponents.a

/**
 * Links in MDX point at content files (`./cli/index.mdx#options`) and resolve here to the page URL in the reader's
 * language, so they survive a changed `DOCS_BASE` and never jump from an English page into the Chinese one.
 */
export function relativeLinkComponents(page: DocsPage) {
  const resolve = (href: string | undefined) => (href ? source.resolveHref(href, page) : href)
  return {
    a: ({ href, ...props }: ComponentProps<'a'>) => <Anchor href={resolve(href)} {...props} />,
    Card: ({ href, ...props }: ComponentProps<typeof Card>) => <Card href={resolve(href)} {...props} />,
  }
}
