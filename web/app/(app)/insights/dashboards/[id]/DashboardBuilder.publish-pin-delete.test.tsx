import assert from 'node:assert/strict'
import test from 'node:test'

// DashboardBuilder F4T2-3: publish, pin and delete fetched and called
// res.json() before checking res.ok, so a non-JSON error body threw a
// SyntaxError that lost the server's named refusal (and delete had no
// catch, so no toast at all). The status is checked first through the
// shared helper; busy always releases in finally.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/insights/dashboards/d-1',
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
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

declare global {
  var __builderToasts: { kind: string; message: string }[] | undefined
  var __builderImpls: Record<string, () => Promise<Response>> | undefined
}

Object.assign(globalThis, {
  __builderToasts: [] as { kind: string; message: string }[],
  __builderImpls: {} as Record<string, () => Promise<Response>>,
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){},replace(){}}}export function usePathname(){return "/insights/dashboards/d-1"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__builderToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__builderToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import('../../../../../messages/en')).default
const { ConfirmRoot } = await import('../../../../../lib/confirm')
const { DashboardBuilder } = await import('./DashboardBuilder')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const dashboard = {
  id: 'd-1',
  name: 'My board',
  description: null,
  status: 'draft',
  layout: [],
  updated_at: '2026-01-05T00:00:00.000Z',
} as const

async function mount(options?: { confirm?: boolean; create?: boolean }) {
  ;(globalThis as Record<string, unknown>).__builderToasts = []
  ;(globalThis as Record<string, unknown>).__builderImpls = {}
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`
    const impl = (globalThis.__builderImpls as Record<string, () => Promise<Response>>)[key]
    if (impl) return impl()
    throw new Error(`unexpected fetch ${key}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const builder = (
    <DashboardBuilder
      dashboard={{ ...dashboard, layout: [] }}
      cards={[]}
      availableCards={[]}
      pinned={false}
      canCreate={options?.create ?? false}
      canPublish
    />
  )
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {options?.confirm ? (
          <>
            <ConfirmRoot />
            {builder}
          </>
        ) : (
          builder
        )}
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

function on(method: string, url: string, impl: () => Promise<Response>) {
  ;(globalThis.__builderImpls as Record<string, () => Promise<Response>>)[`${method} ${url}`] = impl
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
  assert.ok(btn, `must offer a ${label} button`)
  return btn
}

function errors(): string[] {
  return (globalThis.__builderToasts ?? []).filter((t) => t.kind === 'error').map((t) => t.message)
}

test('a non-JSON 500 on publish names the failure and releases the button', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  on('POST', '/api/insights/dashboards/d-1/publish', async () => new Response('', { status: 500 }))
  await act(async () => {
    findButton(document.body, 'Publish').click()
    await tick()
    await tick()
    await tick()
  })
  assert.match(errors().join('\n'), /Update failed \(status 500\)/)
  const publish = findButton(document.body, 'Publish')
  assert.equal(publish.disabled, false, 'busy releases after the failed publish')
})

test('a non-JSON 500 on pin names the failure and releases the button', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  on('POST', '/api/insights/dashboards/d-1/pin', async () => new Response('', { status: 500 }))
  await act(async () => {
    findButton(document.body, 'Pin to home').click()
    await tick()
    await tick()
    await tick()
  })
  assert.match(errors().join('\n'), /Could not update pin \(status 500\)/)
  const pin = findButton(document.body, 'Pin to home')
  assert.equal(pin.disabled, false, 'busy releases after the failed pin')
})

test('a non-JSON 500 on delete names the failure and releases the button', async (t) => {
  const { host, root } = await mount({ confirm: true, create: true })
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  on('DELETE', '/api/insights/dashboards/d-1', async () => new Response('', { status: 500 }))
  await act(async () => {
    findButton(document.body, 'Delete').click()
    await tick()
    await tick()
  })
  await act(async () => {
    findButton(document.body, 'Confirm').click()
    await tick()
    await tick()
    await tick()
  })
  assert.match(errors().join('\n'), /Could not delete the dashboard \(status 500\)/)
  const del = findButton(document.body, 'Delete')
  assert.equal(del.disabled, false, 'busy releases after the failed delete')
})
