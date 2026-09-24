import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

const { registerHooks } = await import('node:module')
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/navigation') return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){},back(){}}};export function usePathname(){return "/payroll/runs/run-1"};export function useSearchParams(){return new URLSearchParams()};export function useParams(){return {}}' }
  if (specifier === 'next/link') return { shortCircuit: true, url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}' }
  if (specifier === 'sonner') return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(){},error(){},warning(){}}' }
  return next(specifier, context)
} })

// F3-15: excluding a stub closed the drawer even when the exclusion
// FAILED, stranding the typed adjustments with the stub that still holds
// them. The drawer closes only on a successful exclusion now. Mounts the
// real drawer under jsdom with an onAdjust that reports success or failure
// and asserts the close follows the outcome, not the click.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/runs/doc-1',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { StubDrawer } = await import('./RunWizard')
const { RunWizard } = await import('./RunWizard')
const { MoneyProvider } = await import('../../../../../components/money-provider')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

type StubDrawerProps = Parameters<typeof StubDrawer>[0]

const stub = {
  id: 'stub-1',
  employee_party_id: 'e1',
  employee_name: 'Ada',
  country: 'CA',
  lines: [],
  factors: {},
} as unknown as StubDrawerProps['stub']

async function mount(
  t: TestContext,
  outcome: boolean,
  closed: { count: number },
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StubDrawer
          stub={stub}
          variance={null}
          change={null}
          onClose={() => {
            closed.count += 1
          }}
          fmt={(v) => String(v ?? '')}
          adjustments={[]}
          components={[]}
          canAdjust
          busy={false}
          onAdjust={async () => outcome}
          buckets={[]}
          regionLabel=""
          traceEngines={{}}
          factorLabels={{}}
        />
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 8; i++) await tick()
  })
}

function excludeButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Exclude from this run'),
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'the Exclude control must render')
  return button
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 10; i++) await tick()
  })
}

test('a refused exclusion keeps the drawer open', async (t) => {
  const closed = { count: 0 }
  await mount(t, false, closed)
  await click(excludeButton())
  assert.equal(closed.count, 0, 'the drawer must stay open over a failed exclusion')
})

test('a successful exclusion closes the drawer', async (t) => {
  const closed = { count: 0 }
  await mount(t, true, closed)
  await click(excludeButton())
  assert.equal(closed.count, 1, 'the drawer must close once the exclusion succeeds')
})

function wizardProps(stubs: unknown[]) {
  return {
    run: { document_id: '11111111-1111-4111-8111-111111111111', document_number: 'PR-104', document_status: 'draft', currency: 'CAD', subsidiary_id: null, posted_entry_id: null, paid_at: null, paid_entry_id: null, schedule_name: 'Biweekly', period_start: '2026-08-01', period_end: '2026-08-14', pay_date: '2026-08-20', tax_year: 2026, run_status: 'calculated', run_type: 'regular', pay_schedule_id: '22222222-2222-4222-8222-222222222222', gross_total: '0', net_total: '0', employer_cost_total: '0', employee_count: 1 },
    stubs, roster: [], adjustments: [], adjustableComponents: [], previousNet: {}, remittance: [], bankAccounts: [], registerReportId: null, registerBuckets: [], regionLabel: 'ON', traceEngines: {}, factorLabels: {}, readiness: { items: [], blockers: 0, warnings: 0, included: 0 }, staleness: { stale: false, reasons: [], calculatedAt: null },
    funding: { netPay: '0', rails: [], liabilities: '0', totalCost: '0', payDate: '2026-08-20', businessDaysToPayDate: 5, accounts: [] }, changes: [], separationSections: [], canRun: true, initialStep: 'review', calculationErrors: [], refusalAcknowledgement: null, refusalsAcknowledged: false, approval: { policyExists: false, pending: false, submitted: false, released: false, outstandingGates: 0, documentStatus: 'draft' }, anomalyBlocks: 0, entityOptions: [], canAttributeEntity: false,
  } as unknown as Parameters<typeof RunWizard>[0]
}

test('an open stub drawer follows its recalculated employee row and PDF link', async (t) => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const row = (id: string, net_pay: string) => ({ ...stub, id, employee_party_id: 'e1', gross: '100', net_pay, employer_cost: '110', province: 'ON' })
  const render = (rows: unknown[]) => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="CAD"><RunWizard {...wizardProps(rows)} /></MoneyProvider></NextIntlClientProvider>
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => { root.render(render([row('old-id', '80')])); await tick() })
  const employee = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('Ada'))
  assert.ok(employee)
  await act(async () => { employee.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
  assert.ok(document.body.querySelector('a[href="/api/record-pdf/pay_stub/old-id"]'))
  await act(async () => { root.render(render([row('new-id', '90')])); await tick() })
  assert.ok(document.body.querySelector('a[href="/api/record-pdf/pay_stub/new-id"]'))
  assert.equal(document.body.querySelector('a[href="/api/record-pdf/pay_stub/old-id"]'), null)
})
