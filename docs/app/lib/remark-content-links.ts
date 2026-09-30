import { existsSync } from 'node:fs'
import { posix, relative, resolve, sep } from 'node:path'
import type { Root } from 'mdast'
import type {} from 'mdast-util-mdx-jsx'
import { getSlugs } from 'fumadocs-core/source'
import { visit } from 'unist-util-visit'
import type { VFile } from 'vfile'
import { docsBase } from '../../site.config.ts'
import { localizedUrl, parseContentFile } from './urls.ts'

const contentDir = resolve('content/docs')
const pageUrl = localizedUrl(docsBase)
const CONTENT_LINK = /^(\.{1,2}\/[^#?]*\.mdx)(#[^?]*)?$/

/**
 * Rewrites links to content files (`../cli/detect.mdx#options`, also in `href` props such as `<Card>`) into page
 * URLs in the language of the linking page, at compile time. Pages, their Markdown twins and `llms-full.txt` then
 * carry the same resolvable links, and a link to a missing page fails the build.
 */
export function remarkContentLinks() {
  return (tree: Root, file: VFile) => {
    const current = relative(contentDir, file.path.split('?')[0]).split(sep).join('/')
    // Files included from outside the content directory, such as web/design.md, link to no content pages.
    if (current.startsWith('..')) return
    const { locale } = parseContentFile(current)
    const rewrite = (href: string) => {
      const match = CONTENT_LINK.exec(href)
      if (!match) return href
      const target = posix.join(posix.dirname(current), match[1])
      if (!existsSync(resolve(contentDir, target))) throw new Error(`${current}: ${href} points at no content file`)
      return pageUrl(getSlugs(target), locale) + (match[2] ?? '')
    }
    visit(tree, node => {
      if (node.type === 'link') node.url = rewrite(node.url)
      if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return
      for (const attribute of node.attributes) {
        if (attribute.type === 'mdxJsxAttribute' && attribute.name === 'href' && typeof attribute.value === 'string') {
          attribute.value = rewrite(attribute.value)
        }
      }
    })
  }
}
