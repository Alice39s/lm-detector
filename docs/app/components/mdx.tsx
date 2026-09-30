import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import { File, Files, Folder } from 'fumadocs-ui/components/files'
import { ImageZoom } from 'fumadocs-ui/components/image-zoom'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import { TypeTable } from 'fumadocs-ui/components/type-table'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { Mermaid } from './mermaid'
import { TokenizerClasses } from './tokenizer-classes'

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: props => <ImageZoom {...props} />,
    Accordion,
    Accordions,
    File,
    Files,
    Folder,
    Mermaid,
    Step,
    Steps,
    Tab,
    Tabs,
    TokenizerClasses,
    TypeTable,
    ...components,
  } satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
