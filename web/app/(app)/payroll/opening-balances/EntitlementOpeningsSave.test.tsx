import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

// The bank carry-in grid's Save parsed the response body BEFORE
// checking the status with no catch around the fetch — the same defect as
// the statutory grid beside it. Mounts the real grid under jsdom and
// drives the failure paths with scripted fetches.
await bootJsdomEnvironment({ url: 'http://localhost:4800/payroll/opening-balances', matchMediaMatches: false })

const toasts: { kind: string; message: string }[] = []
const errorToasts = () => toasts.filter((entry) => entry.kind === 'error').map((entry) => entry.message)
Object.assign(globalThis, {
  __entitlementTestRouter: {
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
      'export function useRouter(){return globalThis.__entitlementTestRouter}' +
      'export function usePathname(){return "/payroll/opening-balances"}' +
      'export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
    sonner:
      'export const toast={success(m){(globalThis.__entitlementTestToasts ?? []).push({kind:"success",message:String(m)})},error(m){(globalThis.__entitlementTestToasts ?? []).push({kind:"error",message:String(m)})},warning(m){(globalThis.__entitlementTestToasts ?? []).push({kind:"warning",message:String(m)})}};export function Toaster(){return null}',
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { EntitlementOpeningsView } = await import('./EntitlementOpeningsView')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const props = {
  initial: {
    plans: [
      {
        id: 'plan-1',
        code: 'VAC',
        systemKey: 'vacation',
        name: 'Vacation',
        unit: 'hours',
        direction: 'accrue',
        accrualMethod: 'fixed',
        accrualValue: null,
        accrualComponentId: null,
        payoutComponentId: null,
        liabilityAccountId: null,
        capBehavior: 'none',
      },
    ],
    rows: [
      {
        employeePartyId: 'emp-1',
        employeeName: 'Ada',
        employeeNumber: null,
        amounts: {},
        dates: {},
        locked: {},
        legacyVacationBalance: null,
      },
    ],
    entered: 0,
    asOf: '2026-01-01',
    blocked: {},
  },
  canManage: true,
} as unknown as Parameters<typeof EntitlementOpeningsView>[0]

async function mount(t: TestContext, responder: () => Response | Promise<Response>): Promise<void> {
  toasts.length = 0
  ;(globalThis as Record<string, unknown>).__entitlementTestToasts = toasts
  const prior = globalThis.fetch
  globalThis.fetch = (async () => responder()) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
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
        <EntitlementOpeningsView {...props} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
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
  const input = document.querySelector('input[aria-label="Ada — Vacation"]') as HTMLInputElement | null
  assert.ok(input, 'the bank carry-in cell must render')
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

test('a named 422 refusal lands in the error panel', async (t) => {
  await mount(t, () =>
    Response.json(
      {
        error: 'entitlement opening amounts must be exact decimals',
        errors: [{ employeePartyId: 'emp-1', employeeName: 'Ada', message: 'Vacation must be exact' }],
        created: 0,
        updated: 0,
        deleted: 0,
      },
      { status: 422 },
    ),
  )
  await editCell('40.00')
  const save = findSave()
  assert.ok(save && !save.disabled, 'Save must enable once a cell is edited')
  await click(save)
  assert.match(document.body.textContent ?? '', /Vacation must be exact/)
})

test('a non-JSON 502 surfaces the fallback with the status, never a SyntaxError', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  }))
  await editCell('40.00')
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
  assert.match(document.body.textContent ?? '', /must use "\." as the decimal point/)
  assert.match(document.body.textContent ?? '', /12\.34/)
  assert.equal(posts, 0, 'an unreadable carry-in must never reach the server')
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
  await editCell('40.00')
  const save = findSave()
  assert.ok(save, 'Save must render')
  await click(save)
  await act(async () => {
    await tick()
    await tick()
  })
  assert.ok(errorToasts().length > 0, 'the transport failure must toast')
  assert.equal(rejections, 0, 'no rejection may escape the save handler')
})
