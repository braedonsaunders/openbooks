import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// OM-09b: the expense drawer filtered splits and the save payload through an
// account-plus-positive-amount predicate, so a row with a description and an
// amount but no account never reached the server: the save succeeded and the
// line vanished. Only truly blank rows may drop; a contentful account-less
// row must refuse by line name and stay in state.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/expenses/reports',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
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

declare global {
  var __expenseRefusalToasts: { kind: string; message: string }[] | undefined
  var __expenseRefusalRouter: { push(url: string): void; refresh(): void; replace(): void; back(): void; prefetch(): void } | undefined
}

Object.assign(globalThis, {
  __expenseRefusalToasts: [],
  __expenseRefusalRouter: { push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__expenseRefusalRouter}export function usePathname(){return "/expenses/reports"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){(globalThis.__expenseRefusalToasts??=[]).push({kind:"success",message:String(m)})},error(m){(globalThis.__expenseRefusalToasts??=[]).push({kind:"error",message:String(m)})},warning(m){(globalThis.__expenseRefusalToasts??=[]).push({kind:"warning",message:String(m)})}};export function Toaster(){return null}',
      }
    }
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){return true}',
      }
    }
    if (specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptDialog(){return null}',
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { ExpenseDrawer, isBlankExpenseLine, findMissingExpenseAccountLine } = await import('./ExpenseDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const REPORT_ID = '019f0000-0000-4000-8000-0000000000b9'
const UPDATED_AT = '2026-09-01T10:00:00.000000Z'

const blankExpenseRow = () => ({
  accountId: '',
  description: '',
  departmentId: '',
  projectId: '',
  taxProfileId: '',
  amount: '',
  taxOverridden: false,
  taxAmount: '',
  settlementType: 'out_of_pocket',
})

test('only a truly blank expense row is blank', () => {
  assert.equal(isBlankExpenseLine(blankExpenseRow()), true)
  assert.equal(isBlankExpenseLine({ accountId: '', amount: '', settlementType: 'out_of_pocket' }), true)
  // The settlement default rides every fresh row: it is not content.
  assert.equal(isBlankExpenseLine({ ...blankExpenseRow(), settlementType: 'out_of_pocket' }), true)
  // …but an explicit settlement choice is.
  assert.equal(isBlankExpenseLine({ ...blankExpenseRow(), settlementType: 'company_paid' }), false)
})

test('any expense content makes the row non-blank — even without an account (OM-09b)', () => {
  for (const content of [
    { accountId: 'a' },
    { description: 'taxi' },
    { amount: '200' },
    { departmentId: 'd1' },
    { taxProfileId: 'code:vat' },
    { cf_note: 'keep me' },
  ]) {
    assert.equal(isBlankExpenseLine({ ...blankExpenseRow(), ...content }), false, JSON.stringify(content))
  }
  // Signed and zero amounts with an account still ride, as before.
  assert.equal(isBlankExpenseLine({ ...blankExpenseRow(), accountId: 'a', amount: '-20' }), false)
  assert.equal(isBlankExpenseLine({ ...blankExpenseRow(), accountId: 'a', amount: '0' }), false)
})

test('the missing-account probe names the first contentful account-less expense row', () => {
  assert.equal(findMissingExpenseAccountLine([blankExpenseRow()]), null)
  assert.deepEqual(
    findMissingExpenseAccountLine([
      { ...blankExpenseRow(), accountId: 'a', amount: '500' },
      { ...blankExpenseRow(), description: 'taxi', amount: '200' },
      blankExpenseRow(),
    ]),
    { index: 1, lineNumber: 2 },
  )
})

test('a contentful account-less expense row survives to the save payload (OM-09b guard)', () => {
  const rows = [
    { ...blankExpenseRow(), accountId: 'a', amount: '500' },
    { ...blankExpenseRow(), description: 'taxi', amount: '200' },
    blankExpenseRow(),
  ]
  const payload = rows.filter((r) => !isBlankExpenseLine(r))
  assert.equal(payload.length, 2)
  assert.deepEqual(findMissingExpenseAccountLine(rows)?.lineNumber, 2)
})

const CANONICAL_LINES = [
  { account_id: 'a1', description: 'hotel', quantity: '1', unit_price: '500', amount: '500.0000', settlement_type: 'out_of_pocket', custom: {}, extra_dims: {} },
  { account_id: '', description: 'taxi', quantity: '1', unit_price: '225', amount: '225.0000', settlement_type: 'company_paid', custom: {}, extra_dims: {} },
]

async function mountDraftReport(t: TestContext) {
  const requests: { url: string; method: string }[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ url, method })
    if (url.startsWith('/api/flows/manual')) return Response.json({ buttons: [] })
    if (url.startsWith('/api/flows/record-state')) {
      return Response.json({ approvalState: { status: 'approved', pendingWith: [], myActions: null }, history: [] })
    }
    if (url === `/api/expenses/${REPORT_ID}` && method === 'GET') {
      return Response.json({
        doc: {
          id: REPORT_ID, kind: 'expense_report', status: 'draft', party_id: '', employee_name: 'Casey',
          document_number: 'EXP-00009', document_date: '2026-07-15', memo: '', subtotal: '500.00',
          tax_total: '0', total: '500.00', custom: {}, extra_dims: {}, updated_at: UPDATED_AT,
        },
        lines: CANONICAL_LINES,
      })
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  globalThis.__expenseRefusalToasts = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ExpenseDrawer
            report={{ doc: { id: REPORT_ID, kind: 'expense_report', status: 'draft', updated_at: UPDATED_AT }, lines: [] } as never}
            initialMode="view"
            employees={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            departments={[]}
            projects={[]}
            segments={[]}
            headerDefs={[]}
            lineDefs={[]}
            canSubmit
            canPost={false}
            canRecall={false}
            closeHref="/expenses/reports"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 6; i++) await tick()
  })
  return { requests }
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
}

test('OM-09b expense: saving with a contentful account-less line refuses by line name and keeps the row', async (t) => {
  const { requests } = await mountDraftReport(t)
  const edit = findButton('Edit')
  assert.ok(edit, 'a draft must offer Edit')
  await click(edit)
  // The company-paid $225 taxi prices into the splits instead of hiding.
  assert.match(document.body.textContent ?? '', /225/, 'the splits must include the account-less line amount')
  const menu = findButton('Actions')
  assert.ok(menu, 'save lives behind the Actions menu')
  await click(menu)
  const save = findButton('Save')
  assert.ok(save, 'edit mode must offer Save')
  await click(save)
  assert.deepEqual(
    requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`),
    [],
    'no expense write may fire while a contentful line has no account',
  )
  const toasts = globalThis.__expenseRefusalToasts ?? []
  assert.ok(
    toasts.some((toast) => toast.kind === 'error' && /Line 2: choose an account/.test(toast.message)),
    `the refusal must toast the grid line and the remedy, got ${JSON.stringify(toasts)}`,
  )
  // The entered row stays in state: the splits still price its $225.
  assert.match(document.body.textContent ?? '', /225/, 'the refused row must stay in the drawer with its amount priced')
  assert.equal(save.disabled, false, 'busy must release after the refusal')
})
