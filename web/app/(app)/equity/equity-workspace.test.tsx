import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'
import type { CapTable } from '@openbooks/engine/equity'

await bootJsdomEnvironment({ url: 'http://localhost/equity', matchMediaMatches: false })
Object.assign(globalThis, { React })
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0)
window.cancelAnimationFrame = (id) => window.clearTimeout(id)
stubModules({
  navigation: { source: 'export function usePathname(){return window.location.pathname} export function useSearchParams(){return new URLSearchParams(window.location.search)} export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){}}} export function notFound(){throw new Error("not found")} export function redirect(){throw new Error("redirect")}' },
  // Charts draw on a canvas the test DOM does not have; their data is asserted through the shared builders.
  extra: { '@openbooks/analytics/viz': 'export function InsightChart(){return null}' },
})
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const { default: messages } = await import('../../../messages/en')
const { MoneyProvider } = await import('../../../components/money-provider')
const { LOCAL_NAVIGATION } = await import('@openbooks/engine/navigation')
const { ViewTabsProvider, PageViewTabs } = await import('../../../components/module-home/view-tabs')
const { EquityOwnership, EquityActivityList } = await import('./OverviewSections')
const { AttentionList } = await import('../purchasing/sections')
const { EquityCapTablePanel } = await import('./CapTablePanel')
const { capTableExportData } = await import('../../../lib/equity-cap-table-export')
const { EquityRunsPanel } = await import('./RunsPanel')
const { EquityWaterfallPanel } = await import('./WaterfallPanel')

async function mount(node: React.ReactNode, url = '/equity') {
  window.history.replaceState({}, '', url)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">{node}</MoneyProvider>
    </NextIntlClientProvider>,
  ))
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}

const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
const cells = (row: Element) => [...row.querySelectorAll('td')].map((cell) => text(cell)).filter(Boolean).join(' ')
const SUB = 'a0000000-0000-4000-8000-000000000001'
const context = (overrides: { canManage?: boolean } = {}) => ({
  subsidiaryId: SUB, currency: 'USD', asOf: '2026-12-15', canManage: true, pending: [], params: { sub: SUB, view: 'compensation' } as Record<string, string>, ...overrides,
})
const asOfControl = { defaultPeriod: 'today', periodPresets: ['today', 'yesterday', 'tomorrow', 'custom'] }

test('the workspace strip shows the overview and five working views, with share classes, plans and stakeholders in More', async () => {
  const equity = LOCAL_NAVIGATION.find((set) => set.id === 'equity')!
  const labels = (messages as unknown as { equity: { tabs: Record<string, string> } }).equity.tabs
  const group = equity.tabs.map((tab) => ({ href: tab.href, label: labels[tab.key.replace('tabs.', '')]!, secondary: tab.secondary, carry: ['sub', 'book', ...(tab.carry ?? [])] }))
  const screen = await mount(<ViewTabsProvider managed groups={[group]}><PageViewTabs /></ViewTabsProvider>, '/equity?view=plans&sub=' + SUB)
  try {
    const strip = screen.host.querySelector('[data-subtabs]')!
    const pills = [...strip.querySelectorAll(':scope > a')].map((link) => text(link))
    assert.deepEqual(pills, ['Overview', 'Cap table', 'Securities', 'Rounds', 'Waterfall', 'Stock comp'])
    const more = strip.querySelector<HTMLButtonElement>('button[aria-haspopup=menu]')!
    assert.equal(text(more), 'More: Plans', 'the active overflow destination names the More control')
    await act(async () => { more.click() })
    const entries = [...document.querySelectorAll('[role=menu] [role=menuitem]')]
    assert.deepEqual(entries.map((entry) => text(entry)), ['Share classes', 'Plans', 'Stakeholders'])
    assert.ok(entries.every((entry) => entry.getAttribute('href')?.includes(`sub=${SUB}`)), 'the legal entity travels between views')
  } finally {
    await screen.close()
  }
})

test('the ownership hero and activity render populated and empty compositions', async () => {
  const populated = await mount(
    <>
      <EquityOwnership empty="No shares" slices={[
        { key: 'class:cs', label: 'CS · Common', shares: '12000000', percent: '56.9200' },
        { key: 'option', label: 'Options', shares: '1500000', percent: '7.1150' },
        { key: 'pool', label: 'Available pool', shares: '800000', percent: '3.7944' },
      ]} />
      <EquityActivityList empty="No activity" items={[{ key: 'event:1', date: 'Oct 1, 2026', text: 'Exercise · OPT-0007 · Maya Chen · 12,000 shares', href: '/equity?view=securities&security=x' }]} />
      <AttentionList allClear="Nothing needs attention." items={[{ tone: 'warning', text: 'Stock compensation is not posted through Sep 30, 2026', href: '/equity?view=compensation' }]} />
    </>,
  )
  try {
    const legend = [...populated.host.querySelectorAll('li')].slice(0, 3).map((row) => [...row.querySelectorAll('span')].map((span) => text(span)).filter(Boolean).join(' '))
    assert.deepEqual(legend, ['CS · Common 12,000,000 56.9%', 'Options 1,500,000 7.1%', 'Available pool 800,000 3.8%'])
    assert.equal(populated.host.querySelector('a[href="/equity?view=securities&security=x"]')?.textContent?.includes('OPT-0007'), true)
    assert.ok(text(populated.host).includes('Stock compensation is not posted through Sep 30, 2026'))
  } finally {
    await populated.close()
  }
  const empty = await mount(
    <>
      <EquityOwnership empty="No shares or awards are outstanding on this date." slices={[]} />
      <EquityActivityList empty="No equity activity recorded yet." items={[]} />
      <AttentionList allClear="Nothing needs attention." items={[]} />
    </>,
  )
  try {
    assert.equal(empty.host.querySelectorAll('li').length, 0)
    assert.ok(text(empty.host).includes('No shares or awards are outstanding on this date.'))
    assert.ok(text(empty.host).includes('No equity activity recorded yet.'))
    assert.ok(text(empty.host).includes('Nothing needs attention.'))
  } finally {
    await empty.close()
  }
})

const COMMON = 'c0000000-0000-4000-8000-000000000001'
const HOLDER = 'b0000000-0000-4000-8000-000000000001'
const EMPLOYEE = 'b0000000-0000-4000-8000-000000000002'
const capTable: CapTable = {
  asOf: '2026-12-15',
  classes: [{
    shareClassId: COMMON, code: 'CS', name: 'Common', kind: 'common' as const, seniority: 0, authorized: '10000000', outstanding: '4000000', asConvertedOutstanding: '4000000',
    awardsOutstanding: '48000', poolAvailable: '952000', fullyDiluted: '5000000', conversionRatio: '1.0000000000', parValue: '0.0001000000', originalIssuePrice: null,
    conversionPrice: null, outstandingPercent: '100.0000', fullyDilutedPercent: '100.0000',
  }],
  holders: [
    { holderPartyId: HOLDER, sharesByClass: { [COMMON]: '4000000' }, asConvertedOutstanding: '4000000', options: '0', rsus: '0', warrants: '0', vestedAwards: '0', fullyDiluted: '4000000', outstandingPercent: '100.0000', fullyDilutedPercent: '98.8142' },
    { holderPartyId: EMPLOYEE, sharesByClass: {}, asConvertedOutstanding: '0', options: '48000', rsus: '0', warrants: '0', vestedAwards: '12000', fullyDiluted: '48000', outstandingPercent: '0.0000', fullyDilutedPercent: '1.1858' },
  ],
  plans: [],
  holdings: [
    { securityId: 's1', securityNumber: 'CS-0001', kind: 'share' as const, holderPartyId: HOLDER, shareClassId: COMMON, planId: null, status: 'outstanding' as const, outstanding: '4000000', vested: '4000000', unvested: '0', asConverted: '4000000', exercisePrice: null },
    { securityId: 'o1', securityNumber: 'OPT-0001', kind: 'option' as const, holderPartyId: EMPLOYEE, shareClassId: COMMON, planId: null, status: 'outstanding' as const, outstanding: '48000', vested: '12000', unvested: '36000', asConverted: '48000', exercisePrice: '0.5000000000' },
  ],
  convertibles: [],
  totals: { outstanding: '4000000', asConvertedOutstanding: '4000000', awardsOutstanding: '48000', poolAvailable: '952000', fullyDiluted: '5000000' },
}

test('the cap table filters its view and instrument with toolbar drop-downs beside the native as-of control', async () => {
  const view = {
    context: { ...context(), params: { sub: SUB, view: 'captable', by: 'holder', instrument: 'option' } }, asOfControl,
    dimension: 'holder' as const, instrument: 'option' as const, query: '', table: capTable, parties: { [HOLDER]: 'Founder One', [EMPLOYEE]: 'Employee One' },
    hasAccountPolicy: true, accountsSetupHref: '/admin/setup/equity-account-policies', reportHref: '/reports/custom/run/r1', asOfReportHref: '/reports/custom/run/r2',
  }
  const screen = await mount(<EquityCapTablePanel view={view} />, `/equity?view=captable&sub=${SUB}&by=holder&instrument=option`)
  try {
    const selects = [...screen.host.querySelectorAll('label')].map((label) => [text(label.querySelector('span')), label.querySelector('select')?.value])
    assert.deepEqual(selects.filter(([name]) => name === 'View' || name === 'Instrument'), [['View', 'holder'], ['Instrument', 'option']])
    assert.ok(text(screen.host).includes('As of'), 'the native as-of control sits on the table toolbar')
    assert.equal(screen.host.querySelector('nav[aria-label="Cap table view"]'), null, 'no sub-tabs above the table')
    const headers = [...screen.host.querySelectorAll('th')].map((cell) => text(cell))
    assert.deepEqual(headers, ['Holder', 'Options outstanding', 'Vested', 'Unvested'])
    const rows = [...screen.host.querySelectorAll('tbody tr')].map(cells)
    assert.deepEqual(rows, ['Employee One 48,000 12,000 36,000', 'Total 48,000 12,000 36,000'], 'only option holders are listed, with an aligned totals row')
  } finally {
    await screen.close()
  }
})

test('the cap table export holds exactly the rows, columns and totals on screen for every filter', async () => {
  const parties = { [HOLDER]: 'Founder One', [EMPLOYEE]: 'Employee One' }
  const labels = (messages as unknown as { equity: { capTable: { columns: Record<string, string> }; waterfall: { columns: { total: string } } } }).equity
  const exportLabels = {
    title: 'Cap table', dateRange: 'As of', class: labels.capTable.columns.class!, holder: labels.capTable.columns.holder!, kind: () => 'common',
    column: (key: string) => labels.capTable.columns[key === 'instrumentOutstanding' ? 'optionOutstanding' : key]!, total: labels.waterfall.columns.total,
  }
  // The page groups digits and shows a dash for none; the file keeps exact text.
  const plain = (value: string) => { const bare = value.replace(/,/g, ''); return bare === '—' || bare === '0' ? '' : bare }
  for (const [dimension, instrument, query] of [['class', 'all', ''], ['holder', 'all', ''], ['holder', 'option', ''], ['holder', 'share', ''], ['holder', 'all', 'employee'], ['class', 'option', 'cs']] as const) {
    const params = { sub: SUB, view: 'captable', by: dimension, instrument, q: query }
    const view = {
      context: { ...context(), params }, asOfControl, dimension, instrument, query, table: capTable, parties,
      hasAccountPolicy: true, accountsSetupHref: '/admin/setup/equity-account-policies', reportHref: null, asOfReportHref: null,
    }
    const screen = await mount(<EquityCapTablePanel view={view} />, `/equity?${new URLSearchParams(params)}`)
    try {
      const exported = capTableExportData({ entity: { id: SUB, name: 'Main', currency: 'USD' }, table: capTable, parties, hasAccountPolicy: true }, { dimension, instrument, query }, exportLabels).groups[0]!
      const headers = [...screen.host.querySelectorAll('th')].map((cell) => text(cell))
      assert.deepEqual(exported.columns, headers, `${dimension}/${instrument}/${query}: the same columns`)
      const rows = [...screen.host.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => plain(text(cell))))
      assert.equal(exported.rows.length, rows.length, `${dimension}/${instrument}/${query}: the same lines and totals row`)
      exported.rows.forEach((row, index) => {
        assert.deepEqual(row.slice(1).map((cell) => plain(String(cell))), rows[index]!.slice(1), `${dimension}/${instrument}/${query}: line ${index} values`)
      })
    } finally {
      await screen.close()
    }
  }
})

const periods = [{ id: 'p11', name: '2026-11', endsOn: '2026-11-30' }, { id: 'p10', name: '2026-10', endsOn: '2026-10-31' }]
const runsView = (overrides: Record<string, unknown> = {}) => ({
  context: context(), run: 'compensation' as const, lines: 'expense' as const, periods, periodId: 'p11', throughDate: '2026-11-30',
  compensation: {
    subsidiaryId: SUB, throughDate: '2026-11-30', currency: 'USD', lastRunThrough: '2026-10-31', total: '1250.0000', releaseTotal: '0.0000', releases: [],
    lines: [{ securityId: 'o1', securityNumber: 'OPT-0001', holderPartyId: EMPLOYEE, kind: 'option' as const, cumulative: '5250.0000', previous: '4000.0000', period: '1250.0000' }],
  },
  interest: null, refusal: null,
  compensationRuns: [{ id: 'run1', throughDate: '2026-10-31', total: '4000.0000', currency: 'USD', journalEntryId: 'je1', entryNumber: 'EQ-SBC-2026-10-31', createdAt: '2026-11-02' }],
  interestRuns: [], parties: { [EMPLOYEE]: 'Employee One' }, historyOpen: false,
  historyHref: `/equity?sub=${SUB}&view=compensation&history=1`, historyCloseHref: `/equity?sub=${SUB}&view=compensation`,
  reportHref: '/reports/custom/run/r3', periodsSetupHref: '/admin/setup/period-close',
  ...overrides,
})

test('stock compensation posts as a period run from its table toolbar, with run history one click away', async () => {
  const screen = await mount(<EquityRunsPanel view={runsView()} />, `/equity?view=compensation&sub=${SUB}`)
  try {
    const toolbarLabels = [...screen.host.querySelectorAll('label span')].map((span) => text(span))
    for (const label of ['Run', 'Period', 'Lines']) assert.ok(toolbarLabels.includes(label), `${label} is a toolbar filter`)
    const post = [...screen.host.querySelectorAll('button')].find((button) => text(button) === 'Post stock compensation for 2026-11')
    assert.ok(post && !post.disabled, 'the run action names its period')
    assert.ok(post.closest('table') === null && post.closest('div')?.textContent?.includes('Run history'), 'the action sits with the run filters, not in the body')
    assert.equal(screen.host.querySelector(`a[href="/equity?sub=${SUB}&view=compensation&history=1"]`)?.textContent, 'Run history')
    assert.equal(screen.host.querySelector('a[href="/reports/custom/run/r3"]')?.textContent, 'Open the expense schedule report')
    assert.ok(text(screen.host).includes('This run is a period close task.'))
    assert.equal(screen.host.querySelectorAll('button[role=tab]').length, 0, 'no sub-tabs')
  } finally {
    await screen.close()
  }
  const reader = await mount(<EquityRunsPanel view={runsView({ context: context({ canManage: false }) })} />)
  try {
    assert.ok(![...reader.host.querySelectorAll('button')].some((button) => text(button).startsWith('Post ')), 'readers see the run without the post action')
  } finally {
    await reader.close()
  }
  const posted = await mount(<EquityRunsPanel view={runsView({ periodId: 'p10', throughDate: '2026-10-31' })} />)
  try {
    const post = [...posted.host.querySelectorAll('button')].find((button) => text(button).startsWith('Post stock compensation'))!
    assert.equal(post.disabled, true, 'a period already run cannot post again')
    assert.ok(text(posted.host).includes('Posted for this period'))
  } finally {
    await posted.close()
  }
  const interest = await mount(<EquityRunsPanel view={runsView({ run: 'interest', compensation: null, interest: { subsidiaryId: SUB, throughDate: '2026-11-30', currency: 'USD', lastRunThrough: null, total: '82.1900', lines: [] } })} />)
  try {
    assert.ok([...interest.host.querySelectorAll('button')].some((button) => text(button) === 'Post note interest for 2026-11'))
    assert.ok(![...interest.host.querySelectorAll('label span')].some((span) => text(span) === 'Lines'), 'note interest has no release lines')
  } finally {
    await interest.close()
  }
  const unconfigured = await mount(<EquityRunsPanel view={runsView({ periods: [], periodId: null, throughDate: null, compensation: null })} />)
  try {
    assert.ok(text(unconfigured.host).includes('No accounting periods'))
    assert.equal(unconfigured.host.querySelector('a[href="/admin/setup/period-close"]')?.textContent, 'Set up periods')
  } finally {
    await unconfigured.close()
  }
})

const SA = 'c0000000-0000-4000-8000-0000000000a1'
const scenario = {
  entity: { id: SUB, name: 'Northstar Cloud', currency: 'USD' },
  grossExitValue: '67200000.0000',
  transactionFees: '0.0000',
  result: {
    exitValue: '67200000.0000', pricePerCommonShare: '3.2000000000',
    classes: [
      { shareClassId: SA, code: 'SERIESA', kind: 'preferred' as const, seniority: 2, participationMode: 'none' as const, converted: true, preference: '0.0000', participation: '14000000.0000', total: '14000000.0000', perShare: '3.2000000000', preferenceEntitlement: '14000000.0000', participationCap: null, alternativeTotal: '14000000.0000' },
      { shareClassId: COMMON, code: 'CS', kind: 'common' as const, seniority: 0, participationMode: 'none' as const, converted: false, preference: '0.0000', participation: '53200000.0000', total: '53200000.0000', perShare: '3.2000000000', preferenceEntitlement: '0.0000', participationCap: null, alternativeTotal: null },
    ],
    payouts: [
      { securityId: 's1', holderPartyId: HOLDER, kind: 'share' as const, shareClassId: SA, amount: '14000000.0000' },
      { securityId: 's2', holderPartyId: HOLDER, kind: 'share' as const, shareClassId: COMMON, amount: '53200000.0000' },
    ],
    holders: [{ holderPartyId: HOLDER, amount: '67200000.0000', percent: '100.0000' }],
    safes: [], unallocated: '0.0000',
  },
  curve: [],
  parties: { [HOLDER]: 'Founder One' },
  classes: { [SA]: 'SERIESA', [COMMON]: 'CS' },
}

test('the waterfall opens computed on the latest post-money, with preset multiples and each class decision explained', async () => {
  const view = {
    context: { ...context(), params: { sub: SUB, view: 'waterfall' } }, asOfControl,
    anchor: { roundName: 'Series A', closedOn: '2025-09-30', postMoney: '67200000.0000' },
    presets: [{ multiple: '0.5', value: '33600000.0000' }, { multiple: '1', value: '67200000.0000' }, { multiple: '2', value: '134400000.0000' }, { multiple: '5', value: '336000000.0000' }],
    inputs: { exitValue: '67200000.0000', transactionFees: '', unvestedAwards: 'participate' as const, changeOfControl: true, terminated: false },
    scenario, refusal: null,
  }
  const screen = await mount(<EquityWaterfallPanel view={view} />, `/equity?view=waterfall&sub=${SUB}`)
  try {
    const chips = [...screen.host.querySelectorAll('button[aria-pressed]')]
    assert.deepEqual(chips.map((chip) => [text(chip), chip.getAttribute('aria-pressed')]), [['0.5×', 'false'], ['1×', 'true'], ['2×', 'false'], ['5×', 'false']])
    assert.equal(screen.host.querySelector<HTMLInputElement>('input[inputmode=decimal]')?.value, '67200000.0000')
    const body = text(screen.host)
    for (const label of ['Proceeds to holders', 'Per common share', 'Payment cascade', 'Conversion decisions', 'As of']) assert.ok(body.includes(label), label)
    assert.ok(body.includes('Converts to common for $14,000,000.00; keeping its $14,000,000.00 preference would pay $14,000,000.00.'))
    const payouts = [...screen.host.querySelectorAll('tbody tr')].map(cells)
    assert.equal(payouts.length, 3)
    assert.ok(payouts[0]!.startsWith('SERIESA Converts to common'))
    assert.equal(payouts[2], 'Total $67,200,000.00 100%', 'the payouts sum to the proceeds')
  } finally {
    await screen.close()
  }
  const prompt = await mount(<EquityWaterfallPanel view={{ ...view, anchor: null, presets: [], inputs: { ...view.inputs, exitValue: '' }, scenario: null }} />)
  try {
    assert.ok(text(prompt.host).includes('Enter an exit value'))
    assert.ok(text(prompt.host).includes('No priced round in USD anchors the presets yet.'))
    assert.equal(prompt.host.querySelectorAll('button[aria-pressed]').length, 0)
  } finally {
    await prompt.close()
  }
})
