import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F3-4: the bank carry-in grid's Save parsed the response body BEFORE
// checking the status with no catch around the fetch — the same defect as
// the statutory grid beside it (F3-3). Mounts the real grid under jsdom and
// drives the failure paths with scripted fetches.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/opening-balances',
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
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__entitlementTestRouter}export function usePathname(){return "/payroll/opening-balances"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){(globalThis.__entitlementTestToasts ?? []).push({kind:"success",message:String(m)})},error(m){(globalThis.__entitlementTestToasts ?? []).push({kind:"error",message:String(m)})},warning(m){(globalThis.__entitlementTestToasts ?? []).push({kind:"warning",message:String(m)})}};export function Toaster(){return null}',
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

async function editCell(value: string): Promise<void> {
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
  await editCell('12,34')
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
