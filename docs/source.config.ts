import { remarkMdxFiles, remarkMdxMermaid } from 'fumadocs-core/mdx-plugins'
import { remarkSteps } from 'fumadocs-core/mdx-plugins/remark-steps'
import { defineConfig } from 'fumadocs-mdx/config'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import { remarkContentLinks } from './app/lib/remark-content-links.ts'

// Collections are declared with the macro API in app/lib/source.ts; this file holds the shared MDX pipeline.
export default defineConfig({
  mdxOptions: {
    // External images (the Deploy to Cloudflare badge) keep their natural size, so the build needs no network.
    remarkImageOptions: { external: false },
    remarkPlugins: [remarkContentLinks, remarkMath, remarkMdxMermaid, remarkMdxFiles, remarkSteps],
    // KaTeX runs before the syntax highlighter, so math blocks are not treated as code.
    rehypePlugins: plugins => [rehypeKatex, ...plugins],
  },
})
