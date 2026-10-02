import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { stubModules } from '../../../../testing/stub-modules'
import {
  leaveCalendarMonths,
  leaveCalendarWindow,
} from '../../../../lib/hrm/leave-calendar'

stubModules({
  navigation: `
  export function usePathname(){return '/hrm/leave'}
  export function useSearchParams(){return new URLSearchParams(globalThis.__calendarSearch ?? '')}
  export function useRouter(){return {replace(href){globalThis.__calendarNavigation = href}}}
`,
})
const { LeaveCalendar } = await import('./LeaveCalendar')
const messages = {
  hrm: JSON.parse(
    readFileSync(
      new URL('../../../../messages/en/hrm.json', import.meta.url),
      'utf8',
    ),
  ),
}
const base = {
  from: '2026-09-01',
  to: '2026-09-30',
  today: '2026-09-22',
  scopeLabel: 'All departments',
  empty: 'No absences in this window.',
}

function render(days: React.ComponentProps<typeof LeaveCalendar>['days']) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <LeaveCalendar {...base} days={days} />
    </NextIntlClientProvider>,
  )
}

test('an empty calendar retains every date, weekdays, current-day marker and month navigation', () => {
  const html = render([])
  assert.equal((html.match(/<time /g) ?? []).length, 30)
  assert.equal((html.match(/scope="col"/g) ?? []).length, 7)
  assert.match(html, /No absences in this window/)
  assert.match(html, /aria-current="date"/)
  assert.match(html, /Previous month/)
  assert.match(html, /Next month/)
  assert.match(html, /All departments/)
})

test('a populated calendar renders every employee and exact hours inside the date grid', () => {
  const html = render([
    {
      date: '2026-09-22',
      entries: [
        {
          employmentId: 'sales',
          workerName: 'Ada Lovelace',
          hours: '7.50',
          leaveTypeCode: 'VAC',
        },
        {
          employmentId: 'operations',
          workerName: 'Grace Hopper',
          hours: '4.00',
          leaveTypeCode: 'SICK',
        },
      ],
    },
  ])
  assert.match(html, /Ada Lovelace/)
  assert.match(html, /Grace Hopper/)
  assert.match(html, /7.50 h/)
  assert.match(html, /4.00 h/)
  assert.match(html, /2 employees on leave/)
  assert.doesNotMatch(html, /No absences in this window/)
})

test('calendar months retain leap days and dates on either side of a year boundary', () => {
  assert.deepEqual(leaveCalendarWindow(undefined, undefined, '2024-02-15'), {
    from: '2024-02-01',
    to: '2024-02-29',
  })
  const months = leaveCalendarMonths('0099-12-25', '0100-01-07')
  assert.deepEqual(
    months.map((month) => month.month),
    ['0099-12-01', '0100-01-01'],
  )
  assert.ok(months[0]?.weeks.flat().includes('0099-12-31'))
  assert.ok(months[1]?.weeks.flat().includes('0100-01-01'))
  assert.equal(leaveCalendarMonths('0001-01-01', '0001-01-31').length, 1)
  assert.equal(leaveCalendarMonths('9999-12-01', '9999-12-31').length, 1)
})

test('invalid calendar windows refuse instead of rendering a misleading empty grid', () => {
  assert.throws(
    () => leaveCalendarWindow('2026-02-30', undefined, base.today),
    /valid YYYY-MM-DD/,
  )
  assert.throws(
    () => leaveCalendarWindow('2026-10-02', '2026-10-01', base.today),
    /end date on or after/,
  )
  assert.throws(
    () => leaveCalendarWindow('2025-01-01', '2026-10-01', base.today),
    /366 days or fewer/,
  )
})

test('month navigation preserves the optional department and selected view', async (context) => {
  await bootJsdomEnvironment({ event: 'jsdom' })
  const state = globalThis as Record<string, unknown>
  state.IS_REACT_ACT_ENVIRONMENT = true
  state.__calendarSearch = 'view=calendar&department=sales&page=2'
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  context.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <LeaveCalendar {...base} days={[]} />
      </NextIntlClientProvider>,
    ),
  )
  for (const [label, from, to] of [
    ['Previous month', '2026-08-01', '2026-08-31'],
    ['Next month', '2026-10-01', '2026-10-31'],
    ['Today', '2026-09-01', '2026-09-30'],
  ]) {
    const button = Array.from(host.querySelectorAll('button')).find(
      (button) =>
        (button.getAttribute('aria-label') ?? button.textContent) === label,
    )
    assert.ok(button)
    await act(async () => button.click())
    const href = new URL(
      state.__calendarNavigation as string,
      'https://openbooks.test',
    )
    assert.equal(href.pathname, '/hrm/leave')
    assert.equal(href.searchParams.get('department'), 'sales')
    assert.equal(href.searchParams.get('view'), 'calendar')
    assert.equal(href.searchParams.get('from'), from)
    assert.equal(href.searchParams.get('to'), to)
    assert.equal(href.searchParams.has('page'), false)
  }
})
