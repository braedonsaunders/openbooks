'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Popover, cn } from '@openbooks/ui'

/** A compact status row keeps the complete refusal and remedy available. */
export function SchedulingAlert({ message, remedy, tone = 'error', children }: { message: string; remedy?: string | null; tone?: 'error' | 'info' | 'warning'; children?: ReactNode }) {
  const t = useTranslations('scheduling')
  const [open, setOpen] = useState(false)
  return <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex min-w-0 shrink-0 flex-nowrap items-center gap-1.5 rounded-lg px-2 py-1 text-xs', tone === 'error' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' : tone === 'warning' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100' : 'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300')}>
    <span className="min-w-0 flex-1 truncate" title={[message, remedy].filter(Boolean).join(' ')}>{message}</span>
    <Popover open={open} onOpenChange={setOpen} align="end" className="w-96 max-w-[calc(100vw-2rem)]" trigger={<Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{t('toolbar.details')}</Button>}>
      <div className="max-h-[60vh] overflow-auto p-3 text-sm"><p>{message}</p>{remedy ? <p className="mt-2">{remedy}</p> : null}</div>
    </Popover>
    {children ? <div className="flex shrink-0 flex-nowrap items-center gap-1">{children}</div> : null}
  </div>
}
