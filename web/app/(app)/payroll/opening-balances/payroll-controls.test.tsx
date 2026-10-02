import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment({ matchMediaMatches: false })
stubModules({
  navigation: { source: 'export function useRouter(){return {push(){},refresh(){}}}' },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return React.createElement("a",p,p.children)}',
    sonner: 'export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}',
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { OpeningBalancesWorkspace } = await import('./OpeningBalancesWorkspace')
const { RetroWorkspace } = await import('../retro/RetroWorkspace')
const { ParallelRunView } = await import('../parallel-run/ParallelRunView')

const rows = Array.from({ length: 61 }, (_, i) => ({
  employeePartyId: `employee-${i + 1}`, employeeName: `Employee ${String(i + 1).padStart(3, '0')}`,
  employeeNumber: String(i + 1), country: 'CA', province: 'ON', taxYear: 2026,
  amounts: null, componentAmounts: {}, programAmounts: {}, accountBases: [], locked: i === 1,
  lockedBy: i === 1 ? { documentNumber: 'PAY-002', payDate: '2026-09-30' } : null, updatedAt: null,
}))
const openingProps = {
  balances: { year: 2026, currentYear: 2026, initial: { rows, taxYear: 2026, entered: 0, years: [], components: [] }, fields: [{ key: 'grossYtd', label: 'Gross', help: 'Previous provider gross', packs: ['CA'] }], programs: [], components: [], canManage: true },
  banks: { initial: { asOf: '2026-09-01', entered: 0, blocked: {}, plans: [{ id: 'vacation', name: 'Vacation', systemKey: 'vacation', unit: 'hours', direction: 'accrue' }], rows: rows.map((row) => ({ ...row, amounts: {}, dates: {}, locked: {}, legacyVacationBalance: null })) }, canManage: true },
  employerLevies: { year: 2026, levies: [], rows: [], canManage: true },
} as unknown as React.ComponentProps<typeof OpeningBalancesWorkspace>

async function mount(t: TestContext, content: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove(); document.body.replaceChildren() })
  const render = (next: React.ReactNode) => act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="CAD"><BusinessDateProvider today="2026-10-01">{next}</BusinessDateProvider></MoneyProvider></NextIntlClientProvider>))
  await render(content)
  return render
}
const visible = (element: Element) => !element.closest('[hidden]')
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find((node) => visible(node) && node.textContent?.includes(label))
  assert.ok(found, `the ${label} action must be visible`)
  return found
}
async function click(node: HTMLElement) { await act(async () => node.click()) }
async function type(label: string, value: string) {
  const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
  assert.ok(input, `the ${label} input must be available`)
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })) })
}
async function employee(name: string) {
  const row = [...document.querySelectorAll(`tr[aria-label="${name}"]`)].find(visible) as HTMLElement | undefined
  assert.ok(row, `${name} must be in the visible list`)
  await click(row)
}

test('large workforces are paginated and searched without rendering every amount input', async (t) => {
  await mount(t, <OpeningBalancesWorkspace {...openingProps} />)
  assert.equal([...document.querySelectorAll('table')].filter(visible).length, 1)
  assert.equal([...document.querySelectorAll('tr[role="button"]')].filter(visible).length, 25)
  assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length, 0)
  await click(button('Next'))
  await employee('Employee 026')
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
  await type('Employee 026 — Gross', '1250.50')
  await click(button('Done'))
  await type('Search', 'Employee 061')
  await employee('Employee 061')
  await type('Employee 061 — Gross', '300.00')
  await click(button('Done'))
  assert.ok(button('Save (2)'))
})

test('employee and bank drafts survive drawer closure, view switches, and bank tax-year navigation', async (t) => {
  const render = await mount(t, <OpeningBalancesWorkspace {...openingProps} />)
  await employee('Employee 001')
  await type('Employee 001 — Gross', '123.45')
  await click(button('Done'))
  await click(button('Bank carry-ins'))
  await employee('Employee 001')
  await type('Employee 001 — Vacation', '12.5')
  await click(button('Done'))
  await click(button('Employee YTD'))
  await employee('Employee 001')
  assert.equal((document.querySelector('input[aria-label="Employee 001 — Gross"]') as HTMLInputElement).value, '123.45')
  await click(button('Done'))
  await render(<OpeningBalancesWorkspace {...openingProps} balances={{ ...openingProps.balances, year: 2027 }} employerLevies={{ ...openingProps.employerLevies, year: 2027 }} />)
  await click(button('Bank carry-ins'))
  await employee('Employee 001')
  assert.equal((document.querySelector('input[aria-label="Employee 001 — Vacation"]') as HTMLInputElement).value, '12.5')
})

test('consumed employee carry-ins remain read-only in the drawer', async (t) => {
  await mount(t, <OpeningBalancesWorkspace {...openingProps} />)
  await employee('Employee 002')
  assert.equal((document.querySelector('input[aria-label="Employee 002 — Gross"]') as HTMLInputElement).disabled, true)
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /PAY-002/)
})

const register = { id: 'register-1', name: 'Prior September', providerName: 'Previous provider', periodStart: '2026-09-01', periodEnd: '2026-09-15', payDate: '2026-09-18', employeeCount: 61, amountCount: 122, statedGross: '100000', statedNet: '75000', unmappedColumns: [] }
const run = { documentId: 'run-1', label: 'PAY-001', periodStart: register.periodStart, periodEnd: register.periodEnd, payDate: register.payDate, runStatus: 'calculated', employeeCount: 61 }
const parallelProps = { registers: [register], runs: [run], comparisons: [], tolerances: [], slots: [], canManage: true }

test('a suggested parallel run must be explicitly accepted and transport refusals stay in its drawer', async (t) => {
  const prior = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests += 1; throw new Error('Comparison service unavailable') }
  t.after(() => { globalThis.fetch = prior })
  await mount(t, <ParallelRunView {...parallelProps} />)
  await click(button('Imported registers'))
  await click(document.querySelector('tr[aria-label="Prior September"]') as HTMLElement)
  assert.equal(button('Compare').disabled, true)
  await click(button('Use matching run'))
  assert.equal(button('Compare').disabled, false)
  await click(button('Compare'))
  assert.equal(requests, 1)
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Comparison service unavailable/)
  assert.equal(button('Compare').disabled, false)
})

test('a run with only the same pay date is not offered as a matching period', async (t) => {
  await mount(t, <ParallelRunView {...parallelProps} runs={[{ ...run, periodStart: '2026-08-16' }]} />)
  await click(button('Imported registers'))
  await click(document.querySelector('tr[aria-label="Prior September"]') as HTMLElement)
  assert.equal(button('Compare').disabled, true)
  assert.ok(!document.querySelector('[role="dialog"]')!.textContent!.includes('Use matching run'))
})

test('retro review separates payable periods from named refusals and never creates a run during assessment', async (t) => {
  const prior = globalThis.fetch
  const requests: string[] = []
  const period = { candidate: { employeePartyId: 'employee-1', employeeName: 'Ada', sourcePayRunDocumentId: 'source-1', sourceDocumentNumber: 'PAY-001', periodStart: '2026-09-01', periodEnd: '2026-09-15', payDate: '2026-09-18', taxYear: 2026, reasons: [] }, outcome: 'payable', difference: { originalEarnings: '100', recomputedEarnings: '110', previouslySettled: '0', delta: '10', buckets: [] }, blockedReason: null }
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).action)
    return Response.json({ taxYear: 2026, periods: [period, { ...period, candidate: { ...period.candidate, employeeName: 'Grace', employeePartyId: 'employee-2' }, outcome: 'unavailable', difference: null, blockedReason: 'Wage history unavailable; restore the wage history before recalculating.' }], employees: [], payableTotal: '10', overpaidTotal: '0', unavailable: 1 })
  }
  t.after(() => { globalThis.fetch = prior })
  await mount(t, <RetroWorkspace schedules={[{ id: 'schedule-1', name: 'Semi-monthly' }]} canRun />)
  await click(button('New review'))
  await click(button('Find retroactive pay'))
  assert.deepEqual(requests, ['propose'])
  assert.ok(document.querySelector('tr[aria-label="Ada · PAY-001"]'))
  assert.ok(!document.querySelector('tr[aria-label="Grace · PAY-001"]'))
  await click(button('Needs review'))
  await click(document.querySelector('tr[aria-label="Grace · PAY-001"]') as HTMLElement)
  assert.ok([...document.querySelectorAll('[role="dialog"]')].some((dialog) => /restore the wage history/.test(dialog.textContent ?? '')))
})
