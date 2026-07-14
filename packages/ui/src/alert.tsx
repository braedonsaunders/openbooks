import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

const alertVariants = cva('relative w-full rounded-lg border p-4 text-sm shadow-sm', {
  variants: {
    variant: {
      default:
        'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border-slate-200 dark:border-slate-800',
      destructive:
        'border-red-200 dark:border-red-800/60 bg-gradient-to-br from-red-50 dark:from-red-950/40 to-red-50/60 dark:to-red-950/30 text-red-900 dark:text-red-300',
      warning:
        'border-amber-200 dark:border-amber-800/60 bg-gradient-to-br from-amber-50 dark:from-amber-950/40 to-amber-50/60 dark:to-amber-950/30 text-amber-900 dark:text-amber-300',
      success:
        'border-green-200 dark:border-green-800/60 bg-gradient-to-br from-green-50 dark:from-green-950/40 to-green-50/60 dark:to-green-950/30 text-green-900 dark:text-green-300',
      info: 'border-sky-200 dark:border-sky-800/60 bg-gradient-to-br from-sky-50 dark:from-sky-950/40 to-sky-50/60 dark:to-sky-950/30 text-sky-900 dark:text-sky-300',
    },
  },
  defaultVariants: { variant: 'default' },
})

export const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
))
Alert.displayName = 'Alert'

export const AlertTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h5 className={cn('mb-1 leading-tight font-semibold tracking-tight', className)} {...props} />
)

export const AlertDescription = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) => (
  <div className={cn('text-sm leading-relaxed [&_p]:leading-relaxed', className)} {...props} />
)
