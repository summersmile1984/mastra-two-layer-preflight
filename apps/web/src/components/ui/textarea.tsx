import * as React from 'react'
import { cn } from '@/lib/utils'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        'flex min-h-[44px] w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-fg outline-none placeholder:text-mut focus:border-acc focus:ring-2 focus:ring-acc/20 disabled:opacity-50 resize-none',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'
