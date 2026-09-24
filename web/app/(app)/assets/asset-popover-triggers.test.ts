import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

declare global {
  var __assetActionRouter: { refresh(): void } | undefined
  var __assetActionToasts: { kind: string; message: string }[] | undefined
}

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4800/assets',
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
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof globals.ResizeObserver !== 'function') {
  globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__assetActionRouter}export function usePathname(){return '/assets'}export function useSearchParams(){return new URLSearchParams()}",
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__assetActionToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__assetActionToasts??=[]).push({kind:'error',message:String(m)})}}",
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
const { MoneyProvider } = await import('../../../components/money-provider')
const { DisposeButton } = await import('./DisposeButton')
const { RemeasureButton } = await import('./RemeasureButton')
const { DepreciationInputButton } = await import('./DepreciationInputButton')
const { ReverseEventButton } = await import('./ReverseEventButton')
const { RunDepreciationButton } = await import('./RunDepreciationButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

async function mount(t: TestContext, component: React.ReactNode, fetcher: typeof fetch = async () => Response.json({})) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = fetcher
  globalThis.__assetActionRouter = { refresh() {} }
  globalThis.__assetActionToasts = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = previousFetch
  })
  await act(async () => {
    root.render(
      React.createElement(
        NextIntlClientProvider,
        { locale: 'en', messages, timeZone: 'UTC' } as unknown as React.ComponentProps<typeof NextIntlClientProvider>,
        React.createElement(
          BusinessDateProvider,
          { today: '2026-09-24' } as React.ComponentProps<typeof BusinessDateProvider>,
          React.createElement(
            MoneyProvider,
            { currency: 'USD' } as React.ComponentProps<typeof MoneyProvider>,
            component,
          ),
        ),
      ),
    )
    await tick()
  })
  return host
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  assert.ok(button, `expected visible ${label} action`)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
}

function setTextArea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function dialog() {
  return document.body.querySelector('[role="dialog"]')
}

test('dispose opens the sale and write-off form', async (t) => {
  await mount(t, React.createElement(DisposeButton, { assetId: 'asset-1', accountOptions: [] }))
  await clickButton('Dispose')
  assert.match(dialog()?.textContent ?? '', /Sale proceeds/)
  assert.match(dialog()?.textContent ?? '', /Disposal date/)
})

test('revalue opens the carrying-value form', async (t) => {
  await mount(t, React.createElement(RemeasureButton, { assetId: 'asset-1' }))
  await clickButton('Revalue')
  assert.match(dialog()?.textContent ?? '', /New carrying value/)
  assert.match(dialog()?.textContent ?? '', /Apply/)
})

test('recording depreciation opens the evidence form and loads attached files', async (t) => {
  const requests: string[] = []
  await mount(
    t,
    React.createElement(DepreciationInputButton, {
      assetId: 'asset-1',
      schedules: [{ bookId: 'book-1', bookName: 'Corporate', method: 'manual' }],
    }),
    async (input) => {
      requests.push(String(input))
      return Response.json({ attachments: [{ id: 'file-1', name: 'Invoice.pdf' }] })
    },
  )
  await clickButton('Record manual depreciation')
  assert.deepEqual(requests, ['/api/file-cabinet/attachments?targetTable=fixed_assets&targetId=asset-1'])
  assert.match(dialog()?.textContent ?? '', /Depreciation amount/)
  await clickButton('Select an attached file')
  assert.match(document.body.textContent ?? '', /Invoice\.pdf/)
})

test('reversal opens a refusal when lifecycle events cannot be loaded', async (t) => {
  await mount(
    t,
    React.createElement(ReverseEventButton, { assetId: 'asset-1' }),
    async () => Response.json({ error: 'Lifecycle events are unavailable' }, { status: 503 }),
  )
  await clickButton('Reverse event')
  assert.deepEqual(globalThis.__assetActionToasts, [
    { kind: 'error', message: 'Lifecycle events are unavailable' },
  ])
})

test('reversal sends the selected event, date, and trimmed reason and surfaces the refusal', async (t) => {
  const requests: { url: string; method: string; body?: unknown }[] = []
  await mount(
    t,
    React.createElement(ReverseEventButton, { assetId: 'asset-1' }),
    async (input, init) => {
      requests.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
      })
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        return Response.json({ events: [{
          id: 'event-17', kind: 'disposed', occurredOn: '2026-05-31', amount: '125.00',
          entryNumber: 'JE-42', postingDate: '2026-05-31', entryStatus: 'posted', reversible: true,
          blockReason: null, laterKind: null,
        }] })
      }
      return Response.json({ error: 'The reversal period is closed' }, { status: 409 })
    },
  )
  await clickButton('Reverse event')
  assert.match(dialog()?.textContent ?? '', /JE-42/)
  const reason = dialog()?.querySelector('textarea')
  assert.ok(reason, 'reversal reason is required before posting')
  await act(async () => {
    setTextArea(reason, '  Approved correction  ')
    await tick()
  })
  await clickButton('Post reversal')
  assert.deepEqual(requests, [
    { url: '/api/assets/asset-1/reverse-event', method: 'GET', body: undefined },
    {
      url: '/api/assets/asset-1/reverse-event',
      method: 'POST',
      body: { eventId: 'event-17', date: '2026-09-24', reason: 'Approved correction' },
    },
  ])
  assert.deepEqual(globalThis.__assetActionToasts, [
    { kind: 'error', message: 'The reversal period is closed' },
  ])
})

test('run depreciation opens its review drawer without posting', async (t) => {
  const requests: string[] = []
  await mount(
    t,
    React.createElement(RunDepreciationButton, {
      assetId: 'asset-1', assetNumber: 'FA-17', assetName: 'Forklift',
      books: [{ id: 'book-1', name: 'Corporate', is_primary: true }],
      candidates: [], periods: [],
    }),
    async (input) => { requests.push(String(input)); return Response.json({}) },
  )
  await clickButton('Run depreciation')
  assert.match(dialog()?.textContent ?? '', /Review depreciation/)
  assert.deepEqual(requests, [], 'opening review does not preview or post until the operator asks')
})
