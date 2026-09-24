import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F3-3: the adoption grid's Save parsed the response body BEFORE checking
// the status with no catch around the fetch: a non-JSON 502 threw a
// SyntaxError out of the handler (the error panel showed a parse error or
// nothing), and a thrown fetch escaped as an unhandled rejection while the
// grid kept showing the edits as merely unsaved. Mounts the real grid under
// jsdom and drives the failure paths with scripted fetches.
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
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__openingsTestRouter}export function usePathname(){return "/payroll/opening-balances"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: 'data:text/javascript,export const toast={success(m){(globalThis.__openingsTestToasts ?? []).push({kind:"success",message:String(m)})},error(m){(globalThis.__openingsTestToasts ?? []).push({kind:"error",message:String(m)})},warning(m){(globalThis.__openingsTestToasts ?? []).push({kind:"warning",message:String(m)})}};export function Toaster(){return null}',
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
const { OpeningBalancesView } = await import('./OpeningBalancesView')

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
): Promise<void> {
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
        <OpeningBalancesView {...props} initial={initial} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

async function mount(t: TestContext, responder: () => Response | Promise<Response>): Promise<void> {
  await mountWith(t, responder, props.initial)
}

function findSave(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Save'),
  ) as HTMLButtonElement | undefined
}

async function editCell(value: string): Promise<void> {
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

test('a named 422 refusal lands in the error panel with its per-row reasons', async (t) => {
  await mount(t, () =>
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
  )
  await editCell('100.00')
  const save = findSave()
  assert.ok(save && !save.disabled, 'Save must enable once a cell is edited')
  await click(save)
  assert.match(document.body.textContent ?? '', /Gross must be exact/)
  assert.deepEqual(successToasts(), [], 'a refused save must not toast success')
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
