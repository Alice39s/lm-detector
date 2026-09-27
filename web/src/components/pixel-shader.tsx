import { useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react'
import { attachPixelView, type PixelEffect, type PixelViewHandle } from '@/lib/pixel-renderer'
import { cn } from '@/lib/utils'

type PixelShaderProps = Omit<ComponentProps<'span'>, 'children'> & {
  effect: PixelEffect
  /** 每个像素格的 CSS 像素边长。 */
  cell?: number
}

/** 装饰性像素着色器：填满自身尺寸，颜色取 currentColor（含 alpha），不接收指针事件。 */
export function PixelShader({ effect, cell = 4, className, ...props }: PixelShaderProps) {
  const host = useRef<HTMLSpanElement>(null)
  const view = useRef<PixelViewHandle | null>(null)
  useEffect(() => {
    const handle = attachPixelView(host.current!, effect, cell)
    view.current = handle
    return () => {
      handle?.dispose()
      view.current = null
    }
  }, [effect, cell])
  // 父组件切换状态色时随渲染重新取色。
  useLayoutEffect(() => view.current?.refresh())
  return <span ref={host} aria-hidden="true" className={cn('fp-pixel', className)} {...props} />
}

export function PixelSpinner({ className, ...props }: Omit<PixelShaderProps, 'effect' | 'cell'>) {
  return <PixelShader effect="spinner" cell={2} className={cn('size-4 shrink-0', className)} {...props} />
}
