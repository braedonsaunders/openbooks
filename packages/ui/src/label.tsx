import * as React from 'react'
import { cn } from './utils'

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn('text-sm leading-none font-medium text-slate-900 dark:text-slate-100', className)}
    {...props}
  />
))
Label.displayName = 'Label'
