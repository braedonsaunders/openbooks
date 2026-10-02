'use client'

import { useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CalendarDays, ChevronLeft, ChevronRight, Users } from 'lucide-react'
import {
  Button,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  cn,
} from '@openbooks/ui'
import {
  addCalendarDays,
  addMonthsStart,
  endOfMonth,
  parseIsoDate,
  startOfMonth,
} from '@openbooks/engine/platform/civil-date'
import { leaveCalendarMonths } from '../../../../lib/hrm/leave-calendar'

/** The date grid stays visible even when the selected window has no absences. */
export function LeaveCalendar({
  days,
  empty,
  from,
  to,
  today,
  scopeLabel,
}: {
  days: {
    date: string
    entries: {
      employmentId: string
      workerName: string
      hours: string
      leaveTypeCode: string
    }[]
  }[]
  empty: string
  from: string
  to: string
  today: string
  scopeLabel: string
}) {
  const t = useTranslations('hrm.leave')
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const months = leaveCalendarMonths(from, to)
  const byDate = new Map(days.map((day) => [day.date, day.entries]))
  const employees = new Set(
    days.flatMap((day) => day.entries.map((entry) => entry.employmentId)),
  ).size
  const monthFormat = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const dayFormat = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    timeZone: 'UTC',
  })
  const weekdayFormat = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  })
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeZone: 'UTC',
  })
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    weekdayFormat.format(parseIsoDate(addCalendarDays('2026-09-21', i))),
  )
  const firstMonth = startOfMonth(from)
  const lastMonth = startOfMonth(to)
  const heading =
    firstMonth === lastMonth
      ? monthFormat.format(parseIsoDate(firstMonth))
      : `${monthFormat.format(parseIsoDate(firstMonth))} – ${monthFormat.format(parseIsoDate(lastMonth))}`

  function showMonth(anchor: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('view', 'calendar')
    params.set('from', startOfMonth(anchor))
    params.set('to', endOfMonth(anchor))
    params.delete('page')
    startTransition(() => router.replace(`${pathname}?${params}`))
  }

  return (
    <section
      aria-label={t('calendarTitle')}
      aria-busy={pending}
      className="min-h-0 space-y-4 pb-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
            <CalendarDays size={21} aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {heading}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {scopeLabel} · {t('calendarSubtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-sm text-slate-500 sm:inline-flex dark:text-slate-400">
            <Users size={15} aria-hidden="true" />
            {t('calendarEmployees', { count: employees })}
          </span>
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900">
            <Button
              variant="ghost"
              size="sm"
              className="w-8 px-0"
              aria-label={t('calendarPrevious')}
              disabled={pending || firstMonth === '0001-01-01'}
              onClick={() => showMonth(addMonthsStart(from, -1))}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => showMonth(today)}
            >
              {t('calendarToday')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-8 px-0"
              aria-label={t('calendarNext')}
              disabled={pending || lastMonth === '9999-12-01'}
              onClick={() => showMonth(addMonthsStart(to, 1))}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      {days.length === 0 && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
        >
          <CalendarDays
            size={16}
            className="shrink-0 text-slate-400"
            aria-hidden="true"
          />
          {empty}
        </p>
      )}
      {months.map(({ month, weeks }) => (
        <div key={month} className="space-y-3">
          {months.length > 1 && (
            <h3 className="text-base font-semibold text-slate-800 dark:text-slate-200">
              {monthFormat.format(parseIsoDate(month))}
            </h3>
          )}
          <Table
            className="w-full min-w-[740px] table-fixed border-collapse"
            aria-label={monthFormat.format(parseIsoDate(month))}
          >
            <TableHeader>
              <TableRow
                noAnimate
                className="border-b border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/70"
              >
                {weekdays.map((weekday, index) => (
                  <TableHead
                    key={index}
                    scope="col"
                    className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
                  >
                    {weekday}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {weeks.map((week, weekIndex) => (
                <TableRow
                  noAnimate
                  key={weekIndex}
                  className="hover:bg-transparent dark:hover:bg-transparent"
                >
                  {week.map((date, dayIndex) => {
                    const entries = date ? (byDate.get(date) ?? []) : []
                    const inWindow = date !== null && date >= from && date <= to
                    const isToday = date === today
                    return (
                      <TableCell
                        key={date ?? dayIndex}
                        className={cn(
                          'h-36 border-b border-r border-slate-100 p-2 align-top last:border-r-0 dark:border-slate-800/80',
                          weekIndex === weeks.length - 1 && 'border-b-0',
                          (!inWindow || dayIndex > 4) &&
                            'bg-slate-50/70 dark:bg-slate-900/40',
                          isToday && 'bg-teal-50/40 dark:bg-teal-950/20',
                        )}
                      >
                        {date && (
                          <>
                            <div className="mb-2 flex items-center justify-between px-1">
                              <time
                                dateTime={date}
                                aria-label={dateFormat.format(
                                  parseIsoDate(date),
                                )}
                                aria-current={isToday ? 'date' : undefined}
                                className={cn(
                                  'inline-flex h-7 min-w-7 items-center justify-center rounded-full text-xs font-medium tabular-nums',
                                  isToday
                                    ? 'bg-teal-700 text-white shadow-sm dark:bg-teal-500 dark:text-slate-950'
                                    : inWindow
                                      ? 'text-slate-700 dark:text-slate-200'
                                      : 'text-slate-400 dark:text-slate-600',
                                )}
                              >
                                {dayFormat.format(parseIsoDate(date))}
                              </time>
                              {inWindow && entries.length > 0 && (
                                <span className="text-[10px] tabular-nums text-slate-400">
                                  {new Intl.NumberFormat(locale).format(
                                    entries.length,
                                  )}
                                </span>
                              )}
                            </div>
                            {inWindow && entries.length > 0 && (
                              <ul className="space-y-1.5">
                                {entries.map((entry) => (
                                  <li
                                    key={`${entry.employmentId}:${entry.leaveTypeCode}`}
                                    className="rounded-md border border-teal-100 bg-teal-50 px-2 py-1.5 dark:border-teal-900/60 dark:bg-teal-950/40"
                                  >
                                    <p className="break-words text-xs font-semibold leading-4 text-teal-900 dark:text-teal-200">
                                      {entry.workerName}
                                    </p>
                                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[10px] leading-4 text-teal-700 dark:text-teal-400">
                                      <span>{entry.leaveTypeCode}</span>
                                      <span aria-hidden="true">·</span>
                                      <span className="tabular-nums">
                                        {t('calendarHours', {
                                          hours: entry.hours,
                                        })}
                                      </span>
                                    </p>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </section>
  )
}
