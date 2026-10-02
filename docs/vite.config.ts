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
  optimizeDeps: {
    // React Router has no HTML scan entry; the root also reaches the shared, lazy-loaded pixel renderer and `cn`.
    entries: ['app/root.tsx'],
    // Fumadocs serves its packages as source. Include their client dependencies up front so a later optimizer pass
    // cannot change React's shared runtime exports while the browser still has the first pass cached.
    include: [
      '@base-ui/react/accordion',
      '@base-ui/react/collapsible',
      '@base-ui/react/dialog',
      '@base-ui/react/direction-provider',
      '@base-ui/react/menu',
      '@base-ui/react/popover',
      '@base-ui/react/scroll-area',
      '@base-ui/react/select',
      '@base-ui/react/tabs',
      'lucide-react',
      'mermaid',
      'next-themes',
      'unist-util-visit',
      'vfile',
    ],
  },
  build: {
    assetsDir: `${docsBase.slice(1)}/assets`,
    // Mermaid and KaTeX stay in lazily loaded chunks; the warning threshold is for the entry chunks.
    chunkSizeWarningLimit: 1500,
  },
})
