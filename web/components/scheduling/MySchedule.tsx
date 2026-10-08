'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { CalendarDays, ChevronLeft, ChevronRight, Clock, MapPin, MessageSquareText } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { CHIP_COLORS, chipStyle } from './BookingChip'
import { addDays, formatMinutes, targetHue, type BoardEntry } from './model'

/**
 * The person's own schedule as an agenda: every day in the next four weeks
 * that has a booking, today first, with where to be, the hours and the
 * notes the scheduler left.
 */
export function MySchedule({ today, from, through, entries, refusal }: {
  today: string
  from: string
  through: string
  entries: readonly BoardEntry[]
  refusal: { message: string; remedy: string | null } | null
}) {
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const days = useMemo(() => {
    const map = new Map<string, BoardEntry[]>()
    for (const entry of entries) {
      const list = map.get(entry.startsOn) ?? []
      list.push(entry)
      map.set(entry.startsOn, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [entries])
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }), [locale])
  const totalMinutes = entries.filter((entry) => entry.target?.counts !== false).reduce((sum, entry) => sum + entry.workedMinutes, 0)

  if (refusal) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-950">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{refusal.message}</p>
        {refusal.remedy ? <p className="mt-1 text-xs text-slate-500">{refusal.remedy}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link href={`/me/schedule?from=${addDays(from, -28)}`} aria-label={t('toolbar.previous')}><ChevronLeft className="h-4 w-4" /></Link>
        </Button>
        <Button variant="outline" size="sm" asChild><Link href="/me/schedule">{t('toolbar.today')}</Link></Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/me/schedule?from=${addDays(from, 28)}`} aria-label={t('toolbar.next')}><ChevronRight className="h-4 w-4" /></Link>
        </Button>
        <span className="ml-2 text-sm text-slate-600 dark:text-slate-300">{t('mine.summary', { days: days.length, hours: formatMinutes(totalMinutes) })}</span>
      </div>
      {days.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 p-12 text-center dark:border-slate-700">
          <CalendarDays className="h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">{t('mine.empty', { from, through })}</p>
        </div>
      ) : (
        <ol className="space-y-3">
          {days.map(([date, list]) => (
            <li key={date} className={cn('rounded-xl border bg-white p-4 dark:bg-slate-950', date === today ? 'border-teal-300 ring-1 ring-teal-200 dark:border-teal-800 dark:ring-teal-900' : 'border-slate-200 dark:border-slate-800')}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{dayFormat.format(new Date(`${date}T00:00:00Z`))}</span>
                {date === today ? <span className="rounded-full bg-teal-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">{t('toolbar.today')}</span> : null}
              </div>
              <ul className="space-y-2">
                {list.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-start gap-3">
                    <span style={chipStyle(targetHue(entry.target))} className={cn('inline-flex min-w-[6rem] items-center justify-center rounded-lg border px-3 py-1.5 text-sm font-semibold', CHIP_COLORS)}>
                      {entry.target?.code ?? entry.target?.label ?? t('chip.unassigned')}
                    </span>
                    <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                      <div className="font-medium text-slate-800 dark:text-slate-100">
                        {entry.target?.label}{entry.detail ? ` — ${entry.detail}` : ''}{entry.projectTaskName ? ` · ${entry.projectTaskName}` : ''}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{entry.startClock}–{entry.endClock} · {formatMinutes(entry.workedMinutes)}</span>
                        {entry.target?.context ? <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{entry.target.context}</span> : null}
                        <span>{entry.boardName}</span>
                      </div>
                      {entry.notes ? (
                        <p className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                          <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0" />{entry.notes}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
