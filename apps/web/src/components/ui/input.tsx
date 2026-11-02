import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-fg shadow-[var(--shadow-soft)] outline-none placeholder:text-mut focus:border-acc focus:ring-2 focus:ring-acc/20 disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
