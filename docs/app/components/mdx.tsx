import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import { Cards } from 'fumadocs-ui/components/card'
import { File, Files, Folder } from 'fumadocs-ui/components/files'
import { ImageZoom } from 'fumadocs-ui/components/image-zoom'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import { TypeTable } from 'fumadocs-ui/components/type-table'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { Callout } from './callout'
import { Card } from './card'
import { Mermaid } from './mermaid'
import { TokenizerClasses } from './tokenizer-classes'

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: props => <ImageZoom {...props} />,
    Accordion,
    Accordions,
    Callout,
    Card,
    // design.md cards: 16px apart; tabs form one card, with the panel on the same surface instead of a nested one.
    Cards: props => <Cards {...props} className="gap-4" />,
    File,
    Files,
    Folder,
    Mermaid,
    Step,
    Steps,
    Tab: props => <Tab {...props} className="rounded-none bg-transparent text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-fd-ring" />,
    Tabs: props => <Tabs {...props} className="rounded-(--radius-card) bg-fd-card [&>[role=tablist]]:border-b" />,
    TokenizerClasses,
    TypeTable,
    ...components,
  } satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
