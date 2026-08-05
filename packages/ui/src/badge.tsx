import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-tight transition-colors',
  {
    variants: {
      variant: {
        default:
          'border-teal-200/70 dark:border-teal-800/60 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300',
        secondary:
          'border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200',
        outline:
          'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200',
        destructive:
          'border-red-200/80 dark:border-red-800/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
        warning:
          'border-amber-200/80 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300',
        success:
          'border-green-200/80 dark:border-green-800/60 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
