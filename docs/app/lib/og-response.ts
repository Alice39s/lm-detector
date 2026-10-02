import { createElement } from 'react'
import shadcn from 'fumadocs-ui/css/shadcn.css?raw'
import { ImageResponse } from 'takumi-js/response'
import tokens from '../../../web/src/tokens.css?raw'
import { OgImage, ogSize, type OgPage } from './og-image'
import { ogFontFamilies, ogRenderer } from './og.server'

/**
 * A preview image as a PNG response. The template takes the detector's colour tokens through the same `fd-*` names as
 * the docs: tokens.css holds the values and Fumadocs' shadcn preset maps them. `lang` is a BCP-47 tag, for CJK
 * shaping and line breaking.
 */
export async function ogResponse(page: OgPage, lang: string) {
  return new ImageResponse(createElement(OgImage, page), {
    ...ogSize,
    renderer: await ogRenderer(),
    css: [tokens, shadcn],
    fontFamilies: ogFontFamilies,
    lang,
    format: 'png',
  })
}
