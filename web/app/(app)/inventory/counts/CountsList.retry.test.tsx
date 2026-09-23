import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// IN9: stock-count action retries duplicated counts. countAction minted a
// new UUID per call, so a lost create response plus a retry created a SECOND
// count — and record/submit/post lost their retry identity the same way.
// Every count action now carries one stable per-attempt key: reused on
// retry, rotated after success or an input change.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/inventory?inventoryView=counts',
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
  // Desktop viewport: the pickers render dropdowns instead of the mobile
  // bottom sheet, so options appear as button[role="option"].
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

const COUNT_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const LINE_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const LOC_MAIN = 'loc-main'
const ITEM_WIDGET = '11111111-1111-4111-8111-111111111111'
const SL_BIN = '22222222-2222-4222-8222-222222222222'

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  postBodies: [] as Array<Record<string, unknown>>,
  postBehavior: [] as Array<'fail' | 'ok'>,
}
Object.assign(globalThis, {
  __countRetryToasts: script.toasts,
  __countRetryRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__countRetryRouter}export function usePathname(){return "/inventory"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: 'data:text/javascript,export const toast={success(m){globalThis.__countRetryToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__countRetryToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__countRetryToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
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
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { CountsList } = await import('./CountsList')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const detailResponse = {
  ok: true,
  header: {
    id: COUNT_ID,
    status: 'counting',
    locationId: LOC_MAIN,
    subsidiaryId: 'sub-1',
    countedOn: '2026-09-23',
    memo: null,
    locationName: 'Main',
    subsidiaryName: 'Sub',
  },
  lines: [
    {
      id: LINE_ID,
      itemId: ITEM_WIDGET,
      stockLocationId: SL_BIN,
      lotId: null,
      expectedQuantity: '10',
      countedQuantity: null,
      adjustmentMovementId: null,
      itemCode: 'W-1',
      itemName: 'Widget',
      stockLocationCode: 'BIN-1',
      lotNumber: null,
      variance: null,
    },
  ],
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    counts: [],
    totalCount: 0,
    nextCursor: null,
    locations: [{ id: LOC_MAIN, name: 'Main' }],
    subsidiaries: [{ id: 'sub-1', name: 'Sub' }],
    items: [{ id: ITEM_WIDGET, code: 'W-1', name: 'Widget' }],
    stockLocations: [{ id: SL_BIN, code: 'BIN-1', locationId: LOC_MAIN }],
    lots: [],
    canPost: true,
    canManageStockLocations: true,
    canManageItems: true,
    itemsExcludedCount: 0,
    createRequested: true,
    ...overrides,
  }
}

async function mountCounts(t: TestContext, props: Record<string, unknown>): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'POST') {
      script.postBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      const behavior = script.postBehavior.shift() ?? 'ok'
      if (behavior === 'fail') throw new TypeError('fetch failed')
      // The replay returns the ORIGINAL count id — the retry must surface
      // that same id, never a second count.
      return Response.json({ ok: true, replayed: script.postBodies.length > 1, id: COUNT_ID })
    }
    if (url.includes('counts?id=')) return Response.json(detailResponse)
    return Response.json({ counts: [], totalCount: 0, nextCursor: null })
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
  script.postBodies.length = 0
  script.postBehavior.length = 0
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-23">
            <CountsList {...(props as unknown as React.ComponentProps<typeof CountsList>)} />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
}

function triggersNamed(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll('button[aria-haspopup="listbox"]')].filter(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement[]
}

async function pickOption(triggerLabel: string, optionText: string) {
  const trigger = triggersNamed(triggerLabel)[0]
  assert.ok(trigger, `a ${triggerLabel} picker must exist`)
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  const option = [...document.querySelectorAll('button[role="option"]')].find((b) =>
    (b.textContent ?? '').includes(optionText),
  ) as HTMLElement | undefined
  assert.ok(option, `option ${optionText} must be offered`)
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
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

async function fillCreate(): Promise<void> {
  await pickOption('Business location', 'Main')
  await pickOption('Item', 'Widget')
  await pickOption('Stock location', 'BIN-1')
}

test('a lost create response retried with unchanged fields returns the original count', async (t) => {
  await mountCounts(t, baseProps())
  await fillCreate()
  // Create commits server-side but the response is lost in transport.
  script.postBehavior.push('fail', 'ok')
  await clickButtonNamed('Open count')
  assert.equal(script.postBodies.length, 1, 'the first create must fire exactly one request')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error'),
    'the lost response must surface, not read as silence',
  )
  // Operator presses Open count again with unchanged fields: the retry must
  // carry the SAME key so the server replays the ORIGINAL count id.
  await clickButtonNamed('Open count')
  assert.equal(script.postBodies.length, 2, 'the retry must fire exactly one more request')
  const [first, retry] = script.postBodies as Array<{ action: string; idempotencyKey: string; date: string }>
  assert.equal(first!.action, 'create')
  assert.ok(first!.idempotencyKey, 'the first create must carry a retry identity')
  assert.equal(retry!.idempotencyKey, first!.idempotencyKey, 'the retry must reuse the create key, not mint a new one')
  assert.equal(retry!.date, first!.date, 'the retry must replay the same count payload')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success' && /Count opened/.test(toast.message)),
    'the replayed create must confirm with the original count',
  )
})

test('changing the create inputs after a failure rotates the retry identity', async (t) => {
  await mountCounts(t, baseProps())
  await fillCreate()
  script.postBehavior.push('fail', 'fail')
  await clickButtonNamed('Open count')
  await clickButtonNamed('Open count')
  const [first, retrySame] = script.postBodies as Array<{ idempotencyKey: string }>
  assert.equal(retrySame!.idempotencyKey, first!.idempotencyKey, 'unchanged retry keeps the key (guard)')
  // New intended create after an input change: a reused key with different
  // input would 409, so the drawer must rotate.
  const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
  const memo = inputs.find((input) => input.type === 'text')
  assert.ok(memo, 'a memo input must exist')
  await act(async () => {
    setInputValue(memo, 'second attempt note')
    await tick()
  })
  await tick()
  await clickButtonNamed('Open count')
  assert.equal(script.postBodies.length, 3)
  const third = script.postBodies[2] as { idempotencyKey: string }
  assert.notEqual(third!.idempotencyKey, first!.idempotencyKey, 'an input change must rotate the retry identity')
})

test('a lost record response retried with the same quantity reuses the step key', async (t) => {
  await mountCounts(
    t,
    baseProps({
      counts: [
        {
          id: COUNT_ID,
          status: 'counting',
          locationId: LOC_MAIN,
          locationName: 'Main',
          countedOn: '2026-09-23',
          memo: null,
          lineCount: 1,
          uncountedCount: 1,
          discrepantLineCount: 0,
        },
      ],
      totalCount: 1,
      createRequested: false,
      selectedCountId: COUNT_ID,
    }),
  )
  await tick()
  await tick()
  const counted = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null
  assert.ok(counted, 'a counted-quantity input must render for a counting line')
  await act(async () => {
    setInputValue(counted, '7')
    await tick()
  })
  await tick()
  // Record commits server-side but the response is lost in transport; the
  // operator presses Save again with the same quantity.
  script.postBehavior.push('fail', 'ok')
  await clickButtonNamed('Save')
  await clickButtonNamed('Save')
  assert.equal(script.postBodies.length, 2, 'two saves must fire exactly two requests')
  const [first, retry] = script.postBodies as Array<{ action: string; idempotencyKey: string; countedQuantity: string }>
  assert.equal(first!.action, 'record')
  assert.ok(first!.idempotencyKey, 'the record step must carry a retry identity')
  assert.equal(retry!.idempotencyKey, first!.idempotencyKey, 'the retry must reuse the step key, not mint a new one')
  assert.equal(retry!.countedQuantity, '7', 'the retry must replay the same counted quantity')
})
