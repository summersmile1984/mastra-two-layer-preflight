import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Badge({
  className,
  owner,
  children,
}: {
  className?: string
  owner?: boolean
  children?: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11px] text-mut',
        owner && 'border-amber-200 bg-amber-50 text-amber-700',
        className,
      )}
    >
      {children}
    </span>
  )
}
