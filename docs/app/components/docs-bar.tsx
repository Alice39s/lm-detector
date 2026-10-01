import { useLocation } from 'react-router'
import { useDocsLayout } from 'fumadocs-ui/layouts/docs'
import { PanelLeft } from 'lucide-react'
import { iconButton } from '@/components/site-header'
import { siteText } from '@/lib/layout.shared'
import { docsBase } from '@/lib/shared'
import { localeOf } from '@/lib/urls'

/**
 * Below 1024px, where the page tree becomes a drawer: a bar under the site header that opens it and the search.
 * It takes the place of Fumadocs' own small-screen header, so the layout's row offsets stay in step.
 */
export function DocsBar() {
  const { slots } = useDocsLayout()
  const text = siteText[localeOf(useLocation().pathname, docsBase)]
  const SidebarTrigger = slots.sidebar?.trigger
  const SearchTrigger = slots.searchTrigger && slots.searchTrigger.sm
  return (
    <div className="sticky top-(--fd-docs-row-1) z-30 flex h-(--fd-header-height) items-center justify-between border-b bg-fd-background px-2 [grid-area:header] sm:px-4 md:hidden max-md:layout:[--fd-header-height:--spacing(11)]">
      {SidebarTrigger && (
        <SidebarTrigger className={`${iconButton} w-auto gap-2 px-2 text-sm text-fd-muted-foreground hover:text-fd-foreground`}>
          <PanelLeft aria-hidden="true" />
          {text.pages}
        </SidebarTrigger>
      )}
      {SearchTrigger && <SearchTrigger className={iconButton} />}
    </div>
  )
}
