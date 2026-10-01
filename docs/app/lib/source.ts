import { llms, loader } from 'fumadocs-core/source'
import { defineDocs } from 'fumadocs-mdx/macro'
import { icons } from './icons'
import { i18n } from './i18n'
import { docsBase, siteOrigin } from './shared'
import { localizedUrl } from './urls'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    async: true,
    lastModified: true,
    postprocess: { includeProcessedMarkdown: true },
  },
})

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsBase,
  url: localizedUrl(docsBase),
  i18n,
  icon: name => (name ? icons[name] : undefined),
})

/**
 * Markdown for LLMs. `remarkContentLinks` has already turned links to other pages into site-relative page URLs; the
 * heading carries the page's absolute URL.
 */
export const docsLlms = llms(source, {
  renderPage: async page => `# ${page.data.title} (${siteOrigin}${page.url})

${await page.data.getText('processed')}`,
})
