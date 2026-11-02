import type { SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn('h-9 rounded-lg border border-line bg-panel px-2 text-sm outline-none focus:border-acc', className)}
      {...props}
    />
  )
}
