import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { CaptureListRow } from './sections'

// F1-6: bulk capture actions parsed the body before the status and collapsed
// per-item reasons to counts ("2 succeeded, 1 failed"), so the operator
// could not tell WHICH document failed or WHY. Mounts the real CaptureList
// under jsdom and drives a partial bulk result with scripted fetches.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/ap/capture',
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

const script = {
  errors: [] as string[],
  successes: [] as string[],
}
Object.assign(globalThis, {
  __captureTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__captureTestRouter}export function usePathname(){return "/ap/capture"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){(globalThis.__captureToasts ?? {success:[],error:[]}).success.push(String(m))},error(m){(globalThis.__captureToasts ?? {success:[],error:[]}).error.push(String(m))}};export function Toaster(){return null}',
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
const { CaptureList } = await import('./sections')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function row(id: string, filename: string): CaptureListRow {
  return {
    id,
    status: 'ready',
    filename,
    documentKind: 'vendor_bill',
    vendorName: 'Acme',
    resolvedVendor: null,
    invoiceNumber: 'INV-9',
    invoiceDate: '2026-08-01',
    currency: 'USD',
    total: '100.00',
    overallConfidence: null,
    validationIssues: [],
    documentId: null,
    receivedAt: '2026-08-02T10:00:00.000Z',
  }
}

async function mount(
  t: TestContext,
  handler: (body: { action: string; ids: string[] }) => Response,
  count = 2,
): Promise<void> {
  script.errors = []
  script.successes = []
  ;(globalThis as Record<string, unknown>).__captureToasts = { success: script.successes, error: script.errors }
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/ap-capture/actions' && (init?.method ?? 'GET') === 'POST') {
      return handler(JSON.parse(String(init?.body)) as { action: string; ids: string[] })
    }
    throw new Error(`unexpected fetch ${String(input)}`)
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
  const rows = Array.from({ length: count }, (_, i) => row(`c${i + 1}`, `invoice-${i + 1}.pdf`))
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CaptureList
          rows={rows}
          currentParams={{}}
          canCreate
          uploadDisabled
          sort="received"
          dir="desc"
        />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
}

function checkboxFor(name: string): HTMLInputElement {
  const box = document.querySelector(`input[aria-label="Select ${name}"]`) as HTMLInputElement | null
  assert.ok(box, `the row checkbox for ${name} must render`)
  return box
}

test('a partial bulk result names each failed document with its reason and keeps it selected', async (t) => {
  await mount(t, () =>
    Response.json({
      results: [
        { id: 'c1', ok: true },
        { id: 'c2', ok: false, error: 'duplicate invoice INV-9' },
      ],
    }),
    2,
  )
  await click(checkboxFor('invoice-1.pdf'))
  await click(checkboxFor('invoice-2.pdf'))
  const drafts = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Create drafts'))
  assert.ok(drafts, 'bulk actions must appear once rows are selected')
  await click(drafts as HTMLButtonElement)
  assert.deepEqual(script.successes, [], 'a partial result must not toast success')
  assert.equal(script.errors.length, 1, 'a partial result must toast once')
  assert.match(script.errors[0]!, /1 succeeded, 1 failed/)
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the failed reasons must render inline, not only in the toast')
  assert.match(alert.textContent ?? '', /invoice-2\.pdf/)
  assert.match(alert.textContent ?? '', /duplicate invoice INV-9/)
  assert.ok(!/invoice-1\.pdf/.test(alert.textContent ?? ''), 'the succeeded document must not be listed as failed')
  assert.equal(checkboxFor('invoice-2.pdf').checked, true, 'the failed row stays selected for a one-click retry')
  assert.equal(checkboxFor('invoice-1.pdf').checked, false, 'the succeeded row leaves the selection')
  const actions = [...document.querySelectorAll('button')].filter((b) => /Reprocess|Reject|Create drafts/.test(b.textContent ?? ''))
  assert.ok(actions.length > 0 && actions.every((b) => !(b as HTMLButtonElement).disabled), 'busy must release after a partial result')
})

test('a non-JSON 502 on a bulk action toasts the translated fallback, never a SyntaxError', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }), 2)
  await click(checkboxFor('invoice-1.pdf'))
  const drafts = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Create drafts'))
  assert.ok(drafts, 'bulk actions must appear once rows are selected')
  await click(drafts as HTMLButtonElement)
  assert.deepEqual(script.errors, ['The capture action failed. (status 502)'])
  assert.equal(document.querySelector('[role="alert"]'), null, 'a transport failure names no per-item reasons')
})

test('a 60-row selection is attempted in bounded batches and unanswered ids stay selected', async (t) => {
  const batches: string[][] = []
  await mount(
    t,
    (body) => {
      batches.push(body.ids)
      // First batch fully answered; second batch answers only 5 of 10 —
      // the old silent-truncation shape. Every requested id must still get
      // exactly one verdict.
      const answered = batches.length === 1 ? body.ids : body.ids.slice(0, 5)
      return Response.json({ results: answered.map((id) => ({ id, ok: true })) })
    },
    60,
  )
  const selectAll = document.querySelector('label input[type="checkbox"]') as HTMLInputElement | null
  assert.ok(selectAll, 'the select-all checkbox must render')
  await click(selectAll)
  const reject = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Reject'))
  assert.ok(reject, 'bulk actions must appear once rows are selected')
  await click(reject as HTMLButtonElement)
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [50, 10],
    'no request may exceed the route batch ceiling',
  )
  assert.equal(script.errors.length, 1)
  assert.match(script.errors[0]!, /55 succeeded, 5 failed/)
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the unanswered ids must render inline')
  assert.match(alert.textContent ?? '', /Not processed in this run/)
  for (let i = 56; i <= 60; i++) {
    assert.equal(checkboxFor(`invoice-${i}.pdf`).checked, true, `unanswered invoice-${i}.pdf must stay selected`)
  }
  assert.equal(checkboxFor('invoice-1.pdf').checked, false, 'an answered row must leave the selection')
})
