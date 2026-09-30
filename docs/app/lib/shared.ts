import { localizedUrl } from './urls'

/** The docs prefix without a trailing slash, defined by `site.config.ts` through `vite.config.ts`. */
export const docsBase = import.meta.env.VITE_DOCS_BASE
/** The detector sits one level above the docs, whatever sub-path the site is deployed under. */
export const appUrl = `${docsBase.replace(/\/[^/]+$/, '')}/`
export const siteOrigin = import.meta.env.VITE_SITE_ORIGIN
export const repository = { user: 'Ikaleio', repo: 'lm-detector', branch: 'main', contentDir: 'docs/content/docs' }
export const repositoryUrl = `https://github.com/${repository.user}/${repository.repo}`

const markdownUrl = localizedUrl(docsBase, 'llms.mdx')
const imageUrl = localizedUrl(docsBase, 'og')

type PageRef = { slugs: string[]; locale?: string }
/** The Markdown twin of a page, pre-rendered for "Copy Markdown" and LLM tools. */
export const pageMarkdownUrl = (page: PageRef) => markdownUrl([...page.slugs, 'content.md'], page.locale)
/** The Open Graph image of a page, pre-rendered at build time. */
export const pageImageUrl = (page: PageRef) => imageUrl([...page.slugs, 'image.png'], page.locale)
