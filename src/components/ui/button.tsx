import * as React from 'react'
import { cn } from '@/lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'outline'
  size?: 'sm' | 'md' | 'icon'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'default' && 'bg-foreground text-background hover:bg-foreground/90',
        variant === 'ghost' && 'hover:bg-foreground/5',
        variant === 'outline' && 'border border-foreground/15 hover:bg-foreground/5',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-9 px-4 text-sm',
        size === 'icon' && 'h-8 w-8',
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
