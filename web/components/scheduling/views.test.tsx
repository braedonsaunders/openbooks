import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactNode } from 'react'
import { stubModules } from '../../testing/stub-modules'
stubModules({ navigation: true })
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
import { scheduleWindow } from '../../testing/schedule-window'
await bootJsdomEnvironment({ event: 'jsdom' })
Object.assign(globalThis, {
  location: window.location,
  history: window.history,
  addEventListener: window.addEventListener.bind(window),
  removeEventListener: window.removeEventListener.bind(window),
})
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client'),
  { act } = React
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../messages/en')).default
const { TargetsView } = await import('./TargetsView'),
  { CalendarView } = await import('./CalendarView')
const { PeopleGrid } = await import('./PeopleGrid')
const { TimelineView } = await import('./TimelineView')
import type { BoardController } from './use-board'
const controller = {
  entriesById: new Map(),
  notify() {},
  run: async () => [],
} as unknown as BoardController
async function mount(
  t: { after: (cb: () => Promise<void>) => void },
  element: ReactNode,
) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        {element}
      </NextIntlClientProvider>,
    ),
  )
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  return host
}

test('duplicate-target day chips identify each native person/resource and preserve configured per-booking colors and actions', async (t) => {
  const original = scheduleWindow()
  const board = {
    ...original,
    rows: [
      original.rows[0]!,
      {
        ...original.rows[1]!,
        subjectKind: 'equipment' as const,
        name: 'Forklift 7',
      },
    ],
    entries: [
      original.entries[0]!,
      {
        ...original.entries[1]!,
        subjectKind: 'equipment' as const,
        workerPartyId: null,
      },
    ],
  }
  const opened: string[] = []
  const host = await mount(
    t,
    <TargetsView
      controller={controller}
      window={board}
      search=""
      today={board.from}
      onOpenEntry={(entry) => opened.push(entry.id)}
      onOpenSourceRecord={() => {}}
    />,
  )
  const chips = [...host.querySelectorAll('tbody button')].filter(
    (b) =>
      b.textContent?.includes('Alex') || b.textContent?.includes('Forklift 7'),
  )
  assert.equal(chips.length, 2)
  assert.ok(chips.every((b) => !b.textContent?.includes('SHOP')))
  assert.notEqual(
    (chips[0] as HTMLElement).style.cssText,
    (chips[1] as HTMLElement).style.cssText,
  )
  await act(async () => {
    ;(chips[1] as HTMLButtonElement).click()
  })
  assert.deepEqual(opened, [board.entries[1]!.id])
  assert.equal(host.querySelectorAll('tbody tr').length, 2)
})

test('literal source target rows put only the person in day chips and keep native source selection', async (t) => {
  const original = scheduleWindow()
  const board = {
    ...original,
    entries: [],
    sourceRecords: [
      {
        id: 'source-1',
        sourceSystem: 'Legacy',
        sourceDataset: 'manpower',
        sourceKey: '1',
        workerPartyId: original.rows[0]!.subjectId,
        onDate: original.from,
        label: 'SHOP/ N',
        result: null,
        notes: null,
        color: '#ff0000',
        visibleInSource: true,
        recordedAt: '2026-10-12',
      },
    ],
  }
  let opened = ''
  const host = await mount(
    t,
    <TargetsView
      controller={controller}
      window={board}
      search="Alex"
      today={board.from}
      onOpenEntry={() => {}}
      onOpenSourceRecord={(r) => {
        opened = r.id
      }}
    />,
  )
  const chip = host.querySelector('tbody button')!
  assert.equal(chip.textContent, 'Alex')
  assert.match(host.querySelector('aside')!.textContent ?? '', /Alex/)
  assert.ok(!host.querySelector('aside')!.textContent?.includes('Blair'))
  assert.match(host.querySelector('tbody td')!.textContent ?? '', /SHOP\/ N/)
  await act(async () => {
    ;(chip as HTMLButtonElement).click()
  })
  assert.equal(opened, 'source-1')
})

test('Month has no second toolbar, keeps bounded equal columns and uses the parent search and subject identity', async (t) => {
  const board = scheduleWindow()
  const host = await mount(
    t,
    <CalendarView
      window={board}
      month="2026-10"
      personId={board.rows[1]!.subjectId}
      search="Blair"
      today={board.from}
      onOpenEntry={() => {}}
      onOpenSourceRecord={() => {}}
    />,
  )
  assert.equal(host.querySelectorAll('select').length, 0)
  assert.ok(host.querySelector('[class*="minmax(0,1fr)"]'))
  assert.ok(!host.textContent?.includes('Alex'))
})

test('the optional hour column disappears without turning source-date unknown hours into zeros', async (t) => {
  const original = scheduleWindow()
  const board = {
    ...original,
    entries: [],
    sourceRecords: [
      {
        id: 'source-1',
        sourceSystem: 'Legacy',
        sourceDataset: 'manpower',
        sourceKey: '1',
        workerPartyId: original.rows[0]!.subjectId,
        onDate: original.from,
        label: 'SHOP',
        result: null,
        notes: null,
        color: '#ff0000',
        visibleInSource: true,
        recordedAt: '2026-10-12',
      },
    ],
  }
  const host = await mount(
    t,
    <PeopleGrid
      controller={controller}
      window={board}
      groupBy="none"
      search=""
      compact
      showHoursColumn={false}
      spotlight={null}
      today={board.from}
      onOpenEntry={() => {}}
      onOpenSourceRecord={() => {}}
    />,
  )
  assert.equal(host.querySelectorAll('[class*="right-0"]').length, 0)
  assert.ok(!host.textContent?.includes('0h'))
  assert.ok([...host.querySelectorAll('button[title]')].some(button =>
    button.getAttribute('title')?.includes(messages.scheduling.source.unknownHours),
  ))
})

test('Timeline receives zoom from the host and contains no duplicate zoom buttons or toolbar', async (t) => {
  const board = scheduleWindow()
  const host = await mount(
    t,
    <TimelineView
      controller={controller}
      window={board}
      zoom={2}
      groupBy="none"
      search=""
      today={board.from}
      onOpenEntry={() => {}}
      onOpenSourceRecord={() => {}}
    />,
  )
  assert.equal(host.querySelectorAll('[aria-label*="Zoom"]').length, 0)
  assert.equal(host.querySelectorAll('[role="toolbar"]').length, 0)
})

test('the header owns search/settings and timeline zoom while More exposes exactly two native window-control rows', async (t) => {
  const { SchedulingWorkspace } = await import('./SchedulingWorkspace')
  const board = scheduleWindow()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return Response.json(board)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const host = await mount(
    t,
    <SchedulingWorkspace
      board={board.board}
      boards={[board.board]}
      view="timeline"
      anchor={board.from}
      from={board.from}
      through={board.through}
      rangeDays={1}
      today={board.from}
      initialWindow={board}
      refusal={null}
      projects={[]}
      selectedProjectId={null}
      canManageProjects={false}
      canConfigure
      timeZone={board.board.timeZone}
      settingsHref="/scheduling?board=CREW"
      scope={{ subsidiaries: [], departments: [], locations: [], projects: [] }}
      peopleEnabled
      tasksEnabled={false}
      resourcesEnabled={false}
      equipmentEnabled={false}
    />,
  )
  assert.equal(
    requests,
    0,
    'the exact server window is reused without a duplicate request',
  )
  const toolbar = host.querySelector('[role="toolbar"]')!
  assert.equal(host.querySelectorAll('[role="toolbar"]').length, 1)
  assert.ok(toolbar.classList.contains('flex-nowrap'))
  assert.ok(toolbar.classList.contains('overflow-x-auto'))
  assert.ok(toolbar.classList.contains('pb-4'), 'scrollbar space stays below header hit targets')
  const search = toolbar.querySelector('input[aria-label]')!
  const settings = toolbar.querySelector('a[aria-label]')!
  assert.ok(
    search.nextElementSibling === settings ||
      search.nextElementSibling?.contains(settings),
  )
  const zoom = [...toolbar.querySelectorAll('button')].filter((b) =>
    b.getAttribute('aria-label')?.toLowerCase().includes('zoom'),
  )
  assert.equal(zoom.length, 2)
  const more = [...toolbar.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === messages.scheduling.toolbar.more,
  )!
  await act(async () => {
    more.click()
  })
  const menu = document.querySelector('[data-schedule-window-menu]')!
  assert.ok(menu)
  assert.equal(menu.children.length, 4)
  assert.equal(menu.querySelectorAll('input[type="date"]').length, 1)
  assert.equal(menu.querySelectorAll('select').length, 2)
  assert.equal(menu.querySelectorAll('input:not([type="date"])').length, 0)
  assert.equal(menu.children[0]!.tagName, 'INPUT')
  assert.equal(menu.children[1]!.tagName, 'BUTTON')
  assert.ok(menu.children[2]!.querySelector('select'))
  assert.ok(menu.children[3]!.querySelector('select'))
})

test('the visible hour-column preference saves through its typed native boundary and stays hidden on reopen', async (t) => {
  const { SchedulingWorkspace } = await import('./SchedulingWorkspace')
  const initial = scheduleWindow(),
    saved = { ...initial, board: { ...initial.board, showHoursColumn: false } }
  const originalFetch = globalThis.fetch,
    seen: { method: string; body: unknown }[] = []
  globalThis.fetch = async (_input, init) => {
    seen.push({
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json(
      init?.method === 'PATCH' ? { id: initial.board.id } : saved,
    )
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const props = {
    boards: [initial.board],
    view: 'grid',
    anchor: initial.from,
    from: initial.from,
    through: initial.through,
    rangeDays: 1,
    today: initial.from,
    refusal: null,
    projects: [],
    selectedProjectId: null,
    canManageProjects: false,
    canConfigure: true,
    timeZone: initial.board.timeZone,
    settingsHref: '/scheduling?board=CREW',
    scope: { subsidiaries: [], departments: [], locations: [], projects: [] },
    peopleEnabled: true,
    tasksEnabled: false,
    resourcesEnabled: false,
    equipmentEnabled: false,
  }
  const host = await mount(
    t,
    <SchedulingWorkspace
      {...props}
      board={initial.board}
      initialWindow={initial}
    />,
  )
  const display = host.querySelector(
    `[aria-label="${messages.scheduling.toolbar.display}"]`,
  ) as HTMLButtonElement
  await act(async () => display.click())
  const label = [...document.querySelectorAll('label')].find(
    (l) => l.textContent === messages.scheduling.toolbar.showHoursColumn,
  )!
  assert.ok(label)
  const input = label.querySelector('input')!
  assert.equal(input.checked, true)
  await act(async () => input.click())
  assert.deepEqual(
    seen.map((r) => r.method),
    ['PATCH', 'GET'],
  )
  assert.deepEqual(seen[0]!.body, { showHoursColumn: false })
  assert.equal(input.checked, false)
  const reopened = await mount(
    t,
    <SchedulingWorkspace
      {...props}
      board={saved.board}
      initialWindow={saved}
    />,
  )
  assert.equal(reopened.querySelectorAll('[class*="right-0"]').length, 0)
})
