import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Renderer } from 'takumi-js/node'

const require = createRequire(import.meta.url)

/** Registers every matching woff2 subset of a Fontsource package as one family, so each script finds its glyphs. */
async function registerFamily(renderer: Renderer, pkg: string, family: string, pattern: RegExp) {
  const dir = join(dirname(require.resolve(`${pkg}/package.json`)), 'files')
  const files = (await readdir(dir)).filter(file => pattern.test(file)).sort()
  if (!files.length) throw new Error(`No font files in ${dir}`)
  for (const [rank, file] of files.entries()) {
    await renderer.registerFont({ name: `${family} ${rank}`, data: await readFile(join(dir, file)), subsetOf: family, subsetRank: rank })
  }
}

/** Text without a font family of its own takes Geist for Latin and Noto Sans SC for Chinese, like `--font-sans`. */
export const ogFontFamilies = ['Geist Variable', 'Noto Sans SC Variable']

let shared: Promise<Renderer> | undefined

/**
 * A Takumi renderer with the fonts of web/src/tokens.css under the names the tokens use, so `var(--font-brand-title)`
 * and `var(--font-brand-byline)` resolve. The fonts bundled with Takumi have no CJK glyphs, so Chinese page titles
 * would otherwise render as empty boxes; the brand title is Latin, so only the Latin subset of Noto Serif SC loads.
 */
export function ogRenderer() {
  return shared ??= (async () => {
    const renderer = new Renderer()
    await registerFamily(renderer, '@fontsource-variable/geist', 'Geist Variable', /^geist-latin(-ext)?-wght-normal\.woff2$/)
    await registerFamily(renderer, '@fontsource-variable/noto-sans-sc', 'Noto Sans SC Variable', /-wght-normal\.woff2$/)
    await registerFamily(renderer, '@fontsource-variable/noto-serif-sc', 'Noto Serif SC Variable', /^noto-serif-sc-latin-wght-normal\.woff2$/)
    return renderer
  })()
}
