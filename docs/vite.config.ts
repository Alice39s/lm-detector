import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite'
import { docsBase, siteOrigin } from './site.config.ts'

export default defineConfig({
  // Vite serves from `/`, so React Router's pre-render server reaches the SPA fallback without a redirect; the
  // assets still live under the docs prefix, next to the pages.
  base: '/',
  define: {
    'import.meta.env.VITE_DOCS_BASE': JSON.stringify(docsBase),
    'import.meta.env.VITE_SITE_ORIGIN': JSON.stringify(siteOrigin),
  },
  plugins: [fumadocsMdx(), tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
  build: {
    assetsDir: `${docsBase.slice(1)}/assets`,
    // Mermaid and KaTeX stay in lazily loaded chunks; the warning threshold is for the entry chunks.
    chunkSizeWarningLimit: 1500,
  },
})
