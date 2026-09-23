import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// IN10: older posted landed-cost vouchers couldn't be reversed in the UI.
// The picker read only the newest 50 vouchers with no status filter or
// cursor, so with 50 newer (even all reversed) vouchers an older
// still-posted one vanished from the only reversal picker. The picker now
// reads posted vouchers from the server — filtered, searched, and paged —
// so every posted voucher stays reachable.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/inventory?inventoryView=onhand',
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
  // Desktop viewport: the picker renders a portaled dropdown instead of the
  // mobile bottom sheet, so options appear as button[role="option"].
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

interface Voucher {
  id: string
  documentNumber: string
  status: string
  amount: string
  voucherDate: string
  memo: string | null
}

// 51 posted vouchers: one older one behind 50 newer ones — the exact shape
// that stranded the older voucher before server-side paging.
const ALL: Voucher[] = [
  { id: 'voucher-old', documentNumber: 'LCV-OLD-0001', status: 'posted', amount: '100.0000', voucherDate: '2026-01-05', memo: 'January freight' },
  ...Array.from({ length: 50 }, (_, i) => ({
    id: `voucher-new-${i}`,
    documentNumber: `LCV-2026-${String(i + 1).padStart(4, '0')}`,
    status: 'posted',
    amount: '10.0000',
    voucherDate: `2026-02-${String((i % 27) + 1).padStart(2, '0')}`,
    memo: null,
  })),
]

function serveLanded(url: string): Record<string, unknown> {
  const u = new URL(url, 'http://localhost')
  const status = u.searchParams.get('status')
  const q = (u.searchParams.get('q') ?? '').trim().toLowerCase()
  const limit = Number(u.searchParams.get('limit') ?? '50')
  const cursorParam = u.searchParams.get('cursor')
  let list = ALL.filter((v) => !status || v.status === status)
  if (q) {
    list = list.filter(
      (v) => v.documentNumber.toLowerCase().includes(q) || (v.memo ?? '').toLowerCase().includes(q),
    )
  }
  list = [...list].sort((a, b) => b.voucherDate.localeCompare(a.voucherDate) || (a.id < b.id ? -1 : 1))
  let start = 0
  if (cursorParam) {
    const c = JSON.parse(Buffer.from(cursorParam, 'base64url').toString('utf8')) as { voucherDate: string; id: string }
    start = list.findIndex((v) => v.voucherDate < c.voucherDate || (v.voucherDate === c.voucherDate && v.id > c.id))
    if (start < 0) start = list.length
  }
  const slice = list.slice(start, start + limit)
  const hasMore = start + limit < list.length
  const last = slice[slice.length - 1]
  return {
    vouchers: slice,
    totalCount: list.length,
    nextCursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({ voucherDate: last.voucherDate, id: last.id }), 'utf8').toString('base64url')
        : null,
  }
}

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  getUrls: [] as string[],
  postBodies: [] as Array<Record<string, unknown>>,
}
Object.assign(globalThis, {
  __voucherTestToasts: script.toasts,
  __voucherTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__voucherTestRouter}export function usePathname(){return "/inventory"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__voucherTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__voucherTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__voucherTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
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
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { ReverseLandedVoucherAction } = await import('./ReverseLandedVoucherAction')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountPicker(t: TestContext): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    if ((init?.method ?? 'GET') === 'POST') {
      script.postBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return Response.json({ replayed: false, voucherId: 'voucher-old', entryId: 'entry-1', alreadyReversed: false })
    }
    script.getUrls.push(url)
    return Response.json(serveLanded(url))
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  script.toasts.length = 0
  script.getUrls.length = 0
  script.postBodies.length = 0
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-23">
          <ReverseLandedVoucherAction />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

async function clickButtonNamed(name: string) {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === name,
  ) as HTMLButtonElement | undefined
  assert.ok(button, `a ${name} button must exist`)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
}

async function openVoucherMenu() {
  const trigger = [...document.querySelectorAll('button[aria-haspopup="listbox"]')].find(
    (b) => b.getAttribute('aria-label') === 'Voucher',
  ) as HTMLButtonElement | undefined
  assert.ok(trigger, 'a Voucher picker must exist')
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

function offeredLabels(): string[] {
  return [...document.querySelectorAll('button[role="option"]')].map((b) => b.textContent ?? '')
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function setTextareaValue(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('an older posted voucher behind 50 newer ones is reachable and reversible', async (t) => {
  await mountPicker(t)
  await clickButtonNamed('Reverse landed-cost voucher')
  await tick()
  assert.ok(script.getUrls.length >= 1, 'opening the dialog must load vouchers')
  assert.ok(
    script.getUrls[0]!.includes('status=posted'),
    `the picker must filter posted server-side, saw: ${script.getUrls[0]}`,
  )
  await openVoucherMenu()
  await tick()
  assert.equal(offeredLabels().length, 50, 'the first page offers 50 vouchers')
  assert.ok(
    !offeredLabels().some((label) => label.includes('LCV-OLD-0001')),
    'the older voucher is not on the first page (guard)',
  )
  // A later page reaches it: the only reversal picker can offer it.
  await clickButtonNamed('Show more (50 of 51)')
  await tick()
  await tick()
  const oldOption = [...document.querySelectorAll('button[role="option"]')].find((b) =>
    (b.textContent ?? '').includes('LCV-OLD-0001'),
  ) as HTMLElement | undefined
  assert.ok(oldOption, 'the older posted voucher must be offered after paging')
  await act(async () => {
    oldOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  const reason = document.querySelector('textarea[placeholder="Why this voucher must be unwound (5-500 characters)"]') as HTMLTextAreaElement | null
  assert.ok(reason, 'a reason field must exist')
  await act(async () => {
    setTextareaValue(reason, 'Freight was billed to the wrong receipt entirely')
    await tick()
  })
  await tick()
  await clickButtonNamed('Reverse voucher')
  assert.equal(script.postBodies.length, 1, 'the reversal must fire exactly one request')
  const reversal = script.postBodies[0] as { action: string; id: string; idempotencyKey: string }
  assert.equal(reversal.action, 'reverseLandedVoucher')
  assert.equal(reversal.id, 'voucher-old', 'the reversal must target the older voucher')
  assert.ok(reversal.idempotencyKey, 'the reversal must carry a retry identity')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success' && /Reversed landed-cost voucher/.test(toast.message)),
    'the reversal must confirm',
  )
})

test('searching the picker queries posted vouchers on the server', async (t) => {
  await mountPicker(t)
  await clickButtonNamed('Reverse landed-cost voucher')
  await tick()
  await openVoucherMenu()
  await tick()
  const search = [...document.querySelectorAll('input')].find(
    (input) => (input as HTMLInputElement).type !== 'date',
  ) as HTMLInputElement | undefined
  assert.ok(search, 'a picker search box must exist')
  const before = script.getUrls.length
  await act(async () => {
    setInputValue(search, 'OLD-0001')
    await tick()
    await tick()
  })
  await tick()
  await tick()
  assert.ok(script.getUrls.length > before, 'typing a query must refetch from the server')
  assert.ok(
    script.getUrls[script.getUrls.length - 1]!.includes('q=OLD-0001'),
    `the search must travel as a server query, saw: ${script.getUrls[script.getUrls.length - 1]}`,
  )
  assert.ok(
    script.getUrls[script.getUrls.length - 1]!.includes('status=posted'),
    'the search must stay within posted vouchers',
  )
  assert.ok(
    offeredLabels().some((label) => label.includes('LCV-OLD-0001')),
    'the search must surface the older voucher',
  )
})
