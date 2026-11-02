import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none',
  {
    variants: {
      variant: {
        default: 'bg-acc text-white hover:bg-acc2',
        ghost: 'bg-transparent text-mut border border-line hover:bg-panel2 hover:text-fg',
        danger: 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100',
        outline: 'border border-line bg-white hover:bg-panel2 text-fg',
        soft: 'bg-panel2 text-fg border border-line hover:bg-wash',
      },
      size: {
        default: 'h-9 px-3 py-2',
        sm: 'h-8 rounded-md px-2.5 text-xs',
        lg: 'h-10 px-4',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  },
)
Button.displayName = 'Button'
