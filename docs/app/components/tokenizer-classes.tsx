import { lazy, Suspense, type ComponentProps } from 'react'

// The bank is 80 KB of JSON, so only pages that show the table download it.
const Table = lazy(() => import('./tokenizer-classes-table'))

export function TokenizerClasses(props: ComponentProps<typeof Table>) {
  return (
    <Suspense fallback={<p className="text-fd-muted-foreground">…</p>}>
      <Table {...props} />
    </Suspense>
  )
}
