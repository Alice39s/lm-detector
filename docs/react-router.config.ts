import type { Config } from '@react-router/dev/config'
import { glob } from 'node:fs/promises'
import { getSlugs } from 'fumadocs-core/source'
import { i18n } from './app/lib/i18n.ts'
import { localizedUrl, parseContentFile } from './app/lib/urls.ts'
import { docsBase } from './site.config.ts'

const pageUrl = localizedUrl(docsBase)
const markdownUrl = localizedUrl(docsBase, 'llms.mdx')
const imageUrl = localizedUrl(docsBase, 'og')

export default {
  // A static site: every page, its Markdown twin, its preview image and the search index are pre-rendered.
  ssr: false,
  async prerender({ getStaticPaths }) {
    const pages = new Set<string>()
    for await (const entry of glob('**/*.mdx', { cwd: 'content/docs' })) pages.add(parseContentFile(entry).path)
    const paths = [...getStaticPaths()]
    // Pages missing in one language fall back to the other, so every page exists under every locale.
    for (const path of pages) {
      const slugs = getSlugs(path)
      for (const locale of i18n.languages) {
        paths.push(pageUrl(slugs, locale), markdownUrl([...slugs, 'content.md'], locale), imageUrl([...slugs, 'image.png'], locale))
      }
    }
    return paths
  },
} satisfies Config
