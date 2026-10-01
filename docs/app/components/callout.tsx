import type { HTMLAttributes, ReactNode } from 'react'
import { CircleCheck, CircleX, Info, Lightbulb, TriangleAlert } from 'lucide-react'

/** The detector's `Alert` with design.md's state colours: primary for notes, warning, destructive and success. */
const tones = {
  info: { icon: Info, className: 'bg-fd-card [&>svg]:text-fd-primary' },
  idea: { icon: Lightbulb, className: 'bg-fd-card [&>svg]:text-fd-primary' },
  warning: { icon: TriangleAlert, className: 'border-fd-warning/40 bg-fd-warning/10 [&>svg]:text-fd-warning' },
  error: { icon: CircleX, className: 'bg-fd-card text-fd-error [&>svg]:text-fd-error' },
  success: { icon: CircleCheck, className: 'bg-fd-card [&>svg]:text-fd-success' },
}

type CalloutProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /** Fumadocs' names; `warn` and `tip` are its aliases of `warning` and `info`. */
  type?: keyof typeof tones | 'warn' | 'tip'
  title?: ReactNode
  icon?: ReactNode
}

export function Callout({ type = 'info', title, icon, children, className, ...props }: CalloutProps) {
  const tone = tones[type === 'warn' ? 'warning' : type === 'tip' ? 'info' : type]
  const Icon = tone.icon
  return (
    <div
      {...props}
      className={`my-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-lg border px-2.5 py-2 text-sm text-fd-card-foreground [&>svg]:row-span-2 [&>svg]:size-4 [&>svg]:translate-y-0.5 ${tone.className} ${className ?? ''}`}
    >
      {icon ?? <Icon aria-hidden="true" />}
      {title && <p className="col-start-2 my-0! font-medium">{title}</p>}
      <div className={`col-start-2 prose-no-margin ${type === 'error' ? 'text-fd-error/90' : 'text-fd-muted-foreground'}`}>{children}</div>
    </div>
  )
}
