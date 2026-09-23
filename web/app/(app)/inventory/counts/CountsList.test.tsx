import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// Cycle-count create refusals: a line with an item but no stock location must
// be refused persistently on its own row — naming the missing field — with
// zero requests leaving the browser, and the same message must also surface
// in the form-level alert. A business location with no stock locations must
// say so in the picker and link to the Stock Locations setup surface.

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

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  fetchCalls: [] as Array<{ url: string; method: string }>,
}
Object.assign(globalThis, {
  __countTestToasts: script.toasts,
  __countTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__countTestRouter}export function usePathname(){return "/inventory"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: 'data:text/javascript,export const toast={success(m){globalThis.__countTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__countTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__countTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
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

const LOC_MAIN = 'loc-main'
const LOC_EMPTY = 'loc-empty'
const ITEM_WIDGET = '11111111-1111-4111-8111-111111111111'
const SL_BIN = '22222222-2222-4222-8222-222222222222'

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
    createRequested: true,
    ...overrides,
  }
}

async function mountCounts(t: TestContext, props: Record<string, unknown>): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    script.fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' })
    return Response.json({ counts: [], totalCount: 0, nextCursor: null })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  // The picker dropdown portals to document.body, so the root IS the body —
  // portaled option clicks would otherwise never reach React.
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  script.toasts.length = 0
  script.fetchCalls.length = 0
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

async function clickButtonNamed(name: string) {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === name,
  ) as HTMLButtonElement | undefined
  assert.ok(button, `a ${name} button must exist`)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

test('a line missing its stock location is refused on the row with zero requests', async (t) => {
  await mountCounts(t, baseProps())
  await pickOption('Business location', 'Main')
  await pickOption('Item', 'Widget')
  await clickButtonNamed('Open count')
  await tick()
  assert.equal(script.fetchCalls.length, 0, 'the refusal must happen client-side: no request may fire')
  const alerts = [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '')
  assert.ok(
    alerts.some((text) => /Line 1: choose a stock location/.test(text)),
    `a row-pinned refusal must name the missing field, saw: ${JSON.stringify(alerts)}`,
  )
  assert.ok(
    alerts.some((text) => /Failed|Line 1: choose a stock location/.test(text) && text.length > 30),
    'the form-level alert must also carry the row refusal',
  )
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error' && /Line 1: choose a stock location/.test(toast.message)),
    'the refusal must also toast',
  )
})

test('a location with no stock locations names the setup surface', async (t) => {
  await mountCounts(
    t,
    baseProps({
      locations: [
        { id: LOC_MAIN, name: 'Main' },
        { id: LOC_EMPTY, name: 'Empty room' },
      ],
    }),
  )
  await pickOption('Business location', 'Empty room')
  await tick()
  const body = document.body.textContent ?? ''
  assert.match(body, /This location has no stock locations yet\./, 'the picker must say the location has none')
  const setupLink = document.querySelector('a[href="/inventory?inventoryView=locations"]')
  assert.ok(setupLink, 'the empty state must link to the Stock Locations setup surface')
  assert.match(setupLink.textContent ?? '', /Set up stock locations/, 'the link must name its remedy')
})

test('without setup permission the empty state has no setup link', async (t) => {
  await mountCounts(
    t,
    baseProps({
      locations: [{ id: LOC_EMPTY, name: 'Empty room' }],
      stockLocations: [],
      canManageStockLocations: false,
    }),
  )
  await pickOption('Business location', 'Empty room')
  await tick()
  const body = document.body.textContent ?? ''
  assert.match(body, /This location has no stock locations yet\./, 'the picker must still say the location has none')
  assert.equal(
    document.querySelector('a[href="/inventory?inventoryView=locations"]'),
    null,
    'readers without setup permission must not get a setup link',
  )
})
