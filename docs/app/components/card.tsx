import type { HTMLAttributes, ReactNode } from 'react'
import Link from 'fumadocs-core/link'

type CardProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  href?: string
  external?: boolean
}

/**
 * Fumadocs' card as a design.md card: 12px radius, a thin border, no shadow and 16px padding. The icon sits beside the
 * title in the muted colour instead of on its own tile.
 */
export function Card({ icon, title, description, href, external, className, children, ...props }: CardProps) {
  const content = (
    <>
      <h3 className="not-prose mb-1 flex items-center gap-2 text-card-title text-fd-card-foreground">
        {icon && <span aria-hidden="true" className="text-fd-muted-foreground [&_svg]:size-4">{icon}</span>}
        {title}
      </h3>
      {description && <p className="my-0! text-sm text-fd-muted-foreground">{description}</p>}
      <div className="text-sm text-fd-muted-foreground prose-no-margin empty:hidden">{children}</div>
    </>
  )
  const surface = `block rounded-(--radius-card) border bg-fd-card p-4 no-underline @max-lg:col-span-full ${className ?? ''}`
  if (!href) return <div {...props} data-card className={surface}>{content}</div>
  return (
    <Link {...props} href={href} external={external} data-card className={`${surface} transition-colors hover:bg-fd-accent/80`}>
      {content}
    </Link>
  )
}
