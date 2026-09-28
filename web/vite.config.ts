import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { apiProxy } from './scripts/vite-proxy.ts'
import telemetry from './telemetry.json' with { type: 'json' }

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    apiProxy(),
    {
      name: 'telemetry',
      apply: 'build',
      transformIndexHtml: () => telemetry.scripts.map(script => ({
        tag: 'script',
        attrs: {
          defer: true,
          src: `${telemetry.origin}/${script}`,
          'data-website-id': telemetry.websiteId,
        },
        injectTo: 'head' as const,
      })),
    },
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    rolldownOptions: {
      output: {
        // 依赖按用途拆成独立分块，应用代码更新时浏览器仍可复用已缓存的依赖。
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/, priority: 3 },
            { name: 'ui', test: /node_modules[\\/](@base-ui|@floating-ui|sonner|lucide-react)[\\/]/, priority: 2 },
            { name: 'motion', test: /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
})
