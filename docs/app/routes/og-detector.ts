import { zh } from '../../../web/src/i18n/messages'
import { ogResponse } from '@/lib/og-response'
import { siteOrigin } from '@/lib/shared'

/**
 * The preview image of the detector's home page, pre-rendered at build time with the docs' images. The detector's
 * index.html is Chinese, so the image is too; the byline is the detector header's.
 */
export function loader() {
  return ogResponse({
    title: zh.detect.title,
    description: zh.app.description,
    section: null,
    byline: 'by Ikaleio',
    host: new URL(siteOrigin).host,
  }, 'zh-Hans')
}
