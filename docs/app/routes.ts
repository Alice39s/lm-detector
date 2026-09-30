import { route, type RouteConfig } from '@react-router/dev/routes'
import { docsBase } from '../site.config.ts'

const prefix = docsBase.slice(1)

export default [
  route(`${prefix}/api/search`, 'routes/search.ts'),
  route(`${prefix}/llms.txt`, 'llms/index.ts'),
  route(`${prefix}/llms-full.txt`, 'llms/full.ts'),
  route(`${prefix}/llms.mdx/*`, 'llms/mdx.ts'),
  route(`${prefix}/en/llms.mdx/*`, 'llms/mdx.ts', { id: 'llms-mdx-en' }),
  route(`${prefix}/og/*`, 'routes/og.ts'),
  route(`${prefix}/en/og/*`, 'routes/og.ts', { id: 'og-en' }),
  route(`${prefix}/en/*`, 'routes/docs.tsx', { id: 'docs-en' }),
  route(`${prefix}/*`, 'routes/docs.tsx'),
] satisfies RouteConfig
