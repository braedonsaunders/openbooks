import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { addCalendarDays, businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { ScheduleError } from '@openbooks/engine/src/schedule-boards/errors.ts'
import { loadMySchedule } from '@openbooks/engine/src/schedule-boards/mine.ts'
import type { BoardEntry } from '@openbooks/engine/src/schedule-boards/window.ts'
import { getAuthz } from '@/lib/authz'
import { meTabs } from '@/lib/hrm/self-service'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/iso-date.ts'

/** The employee's own published schedule: where to be and when, four weeks out. */
export interface MyScheduleData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof meTabs>>
  today: string
  from: string
  through: string
  entries: readonly BoardEntry[]
  refusal: { message: string; remedy: string | null } | null
}

const f = ref<MyScheduleData>()

export async function loadMySchedulePage(searchParams: Record<string, string | string[] | undefined>): Promise<MyScheduleData> {
  const { redirect, notFound } = await import('next/navigation')
  const authz = await getAuthz()
  if (!authz) return redirect('/login')
  const t = await getTranslations('scheduling')
  const today = await businessToday(authz.user.orgId)
  const requested = typeof searchParams.from === 'string' && isIsoCalendarDate(searchParams.from) ? searchParams.from : today
  const from = requested
  const through = addCalendarDays(from, 27)
  const tabs = await meTabs(authz, '/me/schedule')
  try {
    const schedule = await loadMySchedule({ orgId: authz.user.orgId, actorId: authz.user.id, from, through })
    return { title: t('mine.title'), description: t('mine.description'), tabs, today, from, through, entries: schedule.entries, refusal: null }
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { title: t('mine.title'), description: t('mine.description'), tabs, today, from, through, entries: [], refusal: { message: error.message, remedy: error.remedy ?? null } }
    }
    if ((error as { status?: number }).status === 404) notFound()
    throw error
  }
}

export async function myScheduleTitle(): Promise<string> {
  return (await getTranslations('scheduling'))('mine.title')
}

export function myScheduleSpec(data: MyScheduleData): PageSpec {
  return page({
    route: '/me/schedule',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      widgetBlock('scheduling-my-schedule', {
        today: data.today,
        from: data.from,
        through: data.through,
        entries: data.entries,
        refusal: data.refusal,
      }),
    ],
  })
}
