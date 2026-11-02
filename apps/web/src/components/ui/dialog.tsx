import type { ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'
import { Button } from './button'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger

export function DialogContent({
  className,
  children,
  title,
  wide,
  onClose,
}: {
  className?: string
  children: ReactNode
  title: string
  wide?: boolean
  onClose?: () => void
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-fg/35 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow-md)]',
          wide ? 'max-w-[720px]' : 'max-w-[420px]',
          className,
        )}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <DialogPrimitive.Title className="flex-1 text-base font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="sm" onClick={onClose}>
              关闭
            </Button>
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
