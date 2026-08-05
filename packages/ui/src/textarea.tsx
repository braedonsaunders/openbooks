import * as React from 'react'
import { cn } from './utils'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        // text-base below sm: anything under 16px makes iOS Safari zoom the
        // whole viewport when the field is focused.
        'flex min-h-[80px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base placeholder:text-slate-400 sm:text-sm dark:border-slate-700 dark:bg-slate-900 dark:placeholder:text-slate-500',
        'transition-shadow duration-150',
        'focus:border-teal-500 focus:ring-2 focus:ring-teal-500/40 focus:ring-offset-0 focus:outline-none',
        'focus-visible:border-teal-500 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-50 dark:disabled:bg-slate-800',
        'aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:border-red-500 aria-[invalid=true]:focus:ring-red-500/30',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'
