/**
 * Where the docs are served. The build copies them into `web/dist/docs/`, so one static deployment serves the
 * detector at `/` and the docs at `/docs/`. Set `DOCS_BASE` when the site lives under a sub-path, such as a GitHub
 * Pages project site (`/lm-detector/docs`); the last segment stays `docs`, which the detector links to.
 *
 * The routes carry this prefix themselves instead of a React Router basename, so page URLs, the search index and
 * llms.txt all hold the public paths.
 */
export const docsBase = normalizeBase(process.env.DOCS_BASE ?? '/docs')
/** The public origin for absolute URLs in Open Graph tags and the Markdown twins, set with `SITE_ORIGIN`. */
export const siteOrigin = normalizeOrigin(process.env.SITE_ORIGIN ?? 'https://lm.ikale.io')

function normalizeBase(value: string) {
  const base = value.replace(/\/+$/, '')
  if (!/^(\/[\w.-]+)*\/docs$/.test(base)) throw new Error(`DOCS_BASE must be an absolute path ending in "/docs", got "${value}".`)
  return base
}

function normalizeOrigin(value: string) {
  const url = new URL(value)
  if (url.origin !== value.replace(/\/+$/, '')) throw new Error(`SITE_ORIGIN must be an origin such as "https://lm.ikale.io", got "${value}".`)
  return url.origin
}
