import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

// The adoption grid's Save parsed the response body BEFORE checking
// the status with no catch around the fetch: a non-JSON 502 threw a
// SyntaxError out of the handler (the error panel showed a parse error or
// nothing), and a thrown fetch escaped as an unhandled rejection while the
// grid kept showing the edits as merely unsaved. Mounts the real grid under
// jsdom and drives the failure paths with scripted fetches.
await bootJsdomEnvironment({ url: 'http://localhost:4800/payroll/opening-balances', matchMediaMatches: false })

const toasts: { kind: string; message: string }[] = []
const errorToasts = () => toasts.filter((entry) => entry.kind === 'error').map((entry) => entry.message)
const successToasts = () => toasts.filter((entry) => entry.kind === 'success').map((entry) => entry.message)
Object.assign(globalThis, {
  __openingsTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
stubModules({
  navigation: {
    source:
      'export function useRouter(){return globalThis.__openingsTestRouter}' +
      'export function usePathname(){return "/payroll/opening-balances"}' +
      'export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
    sonner:
      'export const toast={success(m){(globalThis.__openingsTestToasts ?? []).push({kind:"success",message:String(m)})},error(m){(globalThis.__openingsTestToasts ?? []).push({kind:"error",message:String(m)})},warning(m){(globalThis.__openingsTestToasts ?? []).push({kind:"warning",message:String(m)})}};export function Toaster(){return null}',
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { OpeningBalancesView } = await import('./OpeningBalancesView')
const { CA_PERIOD_OPENING_TREATMENT } = await import('@openbooks/engine/src/payroll/canada/period-openings.ts')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const props = {
  year: 2026,
  currentYear: 2026,
  initial: {
    taxYear: 2026,
    rows: [
      {
        employeePartyId: 'emp-1',
        employeeName: 'Ada',
        employeeNumber: null,
        country: 'CA',
        province: null,
        taxYear: 2026,
        amounts: null,
        componentAmounts: {},
        programAmounts: {},
        locked: false,
        lockedBy: null,
        updatedAt: null,
      },
    ],
    entered: 0,
    years: [],
    components: [],
  },
  fields: [{ key: 'grossYtd', label: 'Gross', help: 'gross help', packs: ['CA'] }],
  programs: [],
  components: [],
  canManage: true,
} as unknown as Parameters<typeof OpeningBalancesView>[0]

const posted: { url: unknown; init: RequestInit | undefined }[] = []

async function mountWith(
  t: TestContext,
  responder: () => Response | Promise<Response>,
  initial: (typeof props)['initial'],
  fields: (typeof props)['fields'] = props.fields,
): Promise<(year: number) => Promise<void>> {
  toasts.length = 0
  posted.length = 0
  ;(globalThis as Record<string, unknown>).__openingsTestToasts = toasts
  const prior = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    posted.push({ url, init })
    return responder()
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => { await act(async () => rootHandle.unmount()); host.remove(); for (const node of [...document.body.children]) node.remove() })
  const renderYear = (year: number) => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><OpeningBalancesView {...props} year={year} fields={fields} initial={initial} /></NextIntlClientProvider>
  await act(async () => {
    rootHandle.render(renderYear(props.year))
    await tick()
    await tick()
  })
  return async (year) => act(async () => { rootHandle.render(renderYear(year)); await tick() })
}

async function mount(t: TestContext, responder: () => Response | Promise<Response>): Promise<void> {
  await mountWith(t, responder, props.initial)
}

function findSave(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Save'),
  ) as HTMLButtonElement | undefined
}

async function openEmployee(): Promise<void> {
  if (document.querySelector('[role="dialog"]')) return
  const row = document.querySelector('tr[aria-label="Ada"]') as HTMLElement | null
  assert.ok(row, 'the shared employee list must render Ada')
  await act(async () => { row.click(); await tick(); await tick() })
}

async function editCell(value: string): Promise<void> {
  await openEmployee()
  const input = document.querySelector('input[aria-label="Ada — Gross"]') as HTMLInputElement | null
  assert.ok(input, 'the carry-in cell must render')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
    await tick()
  })
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 10; i++) await tick()
  })
}

async function openPeriod(): Promise<void> {
  await openEmployee()
  const tab = [...document.querySelectorAll('button')].find(button => button.textContent === 'Prior-provider period')
  assert.ok(tab, 'period evidence must be a subtab in the existing employee drawer')
  await click(tab)
}

function periodContext() {
  return { employeePartyId: 'emp-1', subsidiaryId: '11111111-1111-4111-8111-111111111111', employerName: 'Employer',
    country: 'CA', baseCurrency: 'CAD', assignedScheduleId: '22222222-2222-4222-8222-222222222222',
    annualUpdatedAt: '2026-01-08 10:00:00+00', fields: CA_PERIOD_OPENING_TREATMENT.fields,
    currencies: [{ value: 'CAD', label: 'CAD' }], schedules: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Weekly' }], record: null }
}

test('period load and retry retain the same employee drawer and surface a non-JSON refusal', async t => {
  let requests = 0
  await mount(t, () => ++requests === 1 ? new Response('gateway failure', { status: 502 }) : Response.json(periodContext()))
  await openEmployee()
  const shell = document.querySelector('[role="dialog"]')
  await openPeriod()
  assert.match(document.body.textContent ?? '', /Could not load period payments.*status 502/)
  assert.equal(document.querySelector('[role="dialog"]'), shell)
  const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Reload current record')
  assert.ok(retry); await click(retry)
  assert.equal(document.querySelector('[role="dialog"]'), shell)
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
  assert.ok(document.querySelector('input[aria-label="Ada — Employee CPP/QPP already withheld (C)"]'))
  assert.equal(successToasts().length, 0)
})

test('period money drafts survive closing and reopening without inventing missing zero amounts', async t => {
  await mount(t, () => Response.json(periodContext()))
  await openPeriod()
  const field = document.querySelector('input[aria-label="Ada — Employee CPP/QPP already withheld (C)"]') as HTMLInputElement
  assert.ok(field)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(field, '11.63')
    field.dispatchEvent(new window.Event('input', { bubbles: true })); await tick()
  })
  const done = [...document.querySelectorAll('button')].find(button => button.textContent === 'Done')
  assert.ok(done); await click(done); await openEmployee()
  assert.equal((document.querySelector('input[aria-label="Ada — Employee CPP/QPP already withheld (C)"]') as HTMLInputElement).value, '11.63')
  const preview = [...document.querySelectorAll('button')].find(button => button.textContent === 'Preview period amounts')
  assert.ok(preview); await click(preview)
  assert.match(document.body.textContent ?? '', /CPP\/QPP pensionable earnings is empty/)
  assert.equal(posted.filter(request => request.init?.method === 'POST').length, 0)
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
})

test('a named 422 refusal lands in the error panel with its per-row reasons', async (t) => {
  const changeYear = await mountWith(t, () =>
    Response.json(
      {
        error: 'opening-balance amounts must be exact decimals',
        errors: [{ employeePartyId: 'emp-1', employeeName: 'Ada', message: 'Gross must be exact' }],
        created: 0,
        updated: 0,
        deleted: 0,
      },
      { status: 422 },
    ),
    props.initial,
  )
  await editCell('100.00'); await changeYear(2027); await openEmployee(); assert.equal((document.querySelector('input[aria-label="Ada — Gross"]') as HTMLInputElement).value, '', 'a year change discards the prior year draft'); await changeYear(2026); await editCell('100.00')
  const save = findSave()
  assert.ok(save && !save.disabled, 'Save must enable once a cell is edited')
  await click(save)
  assert.match(document.body.textContent ?? '', /Gross must be exact/)
  assert.deepEqual(successToasts(), [], 'a refused save must not toast success')
})

test('an orphaned employee keeps pack-specific carry-in inputs available', async (t) => {
  const employee = props.initial.rows[0]!
  const orphaned = {
    ...props.initial,
    rows: [{ ...employee, country: null }],
  }
  await mountWith(t, () => Response.json({ created: 0, updated: 0, deleted: 0 }), orphaned, [
    { key: 'grossYtd', label: 'Canadian income', help: 'Canada', packs: ['CA'] },
    { key: 'federalYtd', label: 'US federal income', help: 'United States', packs: ['US'] },
  ])
  await openEmployee()
  // These columns are read by different statutory packs. With no surviving
  // employee profile, the screen still lets an operator enter both amounts.
  assert.ok(document.querySelector('input[aria-label="Ada — Canadian income"]'))
  assert.ok(document.querySelector('input[aria-label="Ada — US federal income"]'))
})

test('a non-JSON 502 surfaces the fallback with the status, never a SyntaxError', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  }))
  await editCell('100.00')
  const save = findSave()
  assert.ok(save, 'Save must render')
  await click(save)
  const errors = errorToasts()
  assert.ok(errors.some((m) => m.includes('(status 502)')), `expected a status-502 toast, got ${JSON.stringify(errors)}`)
  assert.ok(errors.every((m) => !/SyntaxError|Unexpected token/.test(m)), 'no parse error may surface')
})

test('a decimal comma is refused with its remedy before anything is posted', async (t) => {
  let posts = 0
  await mount(t, () => {
    posts += 1
    return Response.json({ created: 1, updated: 0, deleted: 0 })
  })
  await editCell('12,34')
  const save = findSave()
  assert.ok(save, 'Save must render')
  await click(save)
  // The shared classifier reads 12,34 as twelve-thirty-four (decimal comma),
  // never as a thousands separator to strip — that remedy would store 1234.
  assert.match(document.body.textContent ?? '', /must use "\." as the decimal point/)
  assert.match(document.body.textContent ?? '', /12\.34/)
  assert.equal(posts, 0, 'an unreadable carry-in must never reach the server')
  assert.deepEqual(successToasts(), [], 'a refused save must not toast success')
})

test('a thrown fetch toasts instead of escaping as an unhandled rejection', async (t) => {
  let rejections = 0
  const onRejection = () => {
    rejections += 1
  }
  process.on('unhandledRejection', onRejection)
  t.after(() => {
    process.off('unhandledRejection', onRejection)
  })
  await mount(t, () => {
    throw new TypeError('fetch failed')
  })
  await editCell('100.00')
  const save = findSave()
  assert.ok(save, 'Save must render')
  await click(save)
  await act(async () => {
    await tick()
    await tick()
  })
  assert.ok(errorToasts().length > 0, 'the transport failure must toast')
  assert.equal(rejections, 0, 'no rejection may escape the save handler')
  const again = findSave()
  assert.ok(again && !again.disabled, 'the grid must stay usable after a transport failure')
})

test('the save carries each row loader-served version so a stale write can be refused', async (t) => {
  const initial = {
    ...props.initial,
    rows: props.initial.rows.map((row) => ({ ...row, updatedAt: '2026-09-01 00:00:00+00' })),
  }
  await mountWith(t, () => Response.json({ created: 0, updated: 1, deleted: 0 }), initial)
  await editCell('100.00')
  const save = findSave()
  assert.ok(save, 'Save must render')
  await click(save)
  assert.equal(posted.length, 1, 'one save must be posted')
  const body = JSON.parse(String(posted[0]!.init?.body)) as {
    rows: { employeePartyId: string; updatedAt: string | null }[]
  }
  assert.equal(body.rows[0]!.updatedAt, '2026-09-01 00:00:00+00')
})

test('a 409 stale-row refusal lands in the error panel by name', async (t) => {
  await mount(t, () =>
    Response.json(
      {
        error: 'the carry-in for Ada changed since this screen was loaded',
        errors: [{
          employeePartyId: 'emp-1',
          employeeName: 'Ada',
          message: 'the carry-in for Ada changed since this screen was loaded — reload the page and re-enter your edits',
        }],
        created: 0,
        updated: 0,
        deleted: 0,
      },
      { status: 409 },
    ),
  )
  await editCell('100.00')
  const save = findSave()
  assert.ok(save, 'Save must render')
  await click(save)
  assert.match(document.body.textContent ?? '', /changed since/)
  assert.match(document.body.textContent ?? '', /reload/)
  assert.deepEqual(successToasts(), [], 'a refused save must not toast success')
})
