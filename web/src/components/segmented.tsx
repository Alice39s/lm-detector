import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { RecommendMark } from '@/components/recommend-mark'
import { useMotionPreset } from '@/lib/motion'

/** `icon` sits before the label; `recommended` adds the shared recommendation tag after it, with its text when a string. */
export interface SegmentedOption<T extends string> { value: T; label: string; icon?: ReactNode; recommended?: boolean | string }

export function Segmented<T extends string>({ value, onChange, options, disabled, label }: { value: T; onChange: (v: T) => void; options: SegmentedOption<T>[]; disabled?: boolean; label: string }) {
  const root = useRef<HTMLDivElement>(null)
  const { snappy } = useMotionPreset()
  const [indicator, setIndicator] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const labels = options.map(option => option.label).join('|')
  useLayoutEffect(() => {
    const container = root.current
    if (!container) return
    const measure = () => {
      const selected = container.querySelector<HTMLElement>('[aria-pressed="true"]')
      setIndicator(selected ? { x: selected.offsetLeft, y: selected.offsetTop, width: selected.offsetWidth, height: selected.offsetHeight } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [value, labels])

  return (
    <div ref={root} className="relative isolate w-fit max-w-full">
      {indicator && <motion.span aria-hidden="true" className="pointer-events-none absolute top-0 left-0 rounded-lg bg-muted" initial={false} animate={indicator} transition={snappy} />}
      <ToggleGroup value={[value]} onValueChange={values => { if (values.length) onChange(values[0] as T) }} aria-label={label} disabled={disabled} variant="outline" spacing={0} className="relative min-h-9 flex-wrap justify-start">
        {options.map(o => (
          <ToggleGroupItem key={o.value} value={o.value} className="h-9 flex-none aria-pressed:bg-transparent data-[state=on]:bg-transparent">{o.icon}{o.label}{o.recommended && <RecommendMark className="ml-0.5">{typeof o.recommended === 'string' ? o.recommended : undefined}</RecommendMark>}</ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
