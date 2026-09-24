import assert from 'node:assert/strict'
import test from 'node:test'

// FeaturesWorkspace F4T-16: disabling a feature with stored records called
// the native window.confirm. The house confirm dialog gates the toggle
// instead, so the operator gets the translated impact copy with Confirm /
// Cancel — and automation can drive it.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/features',
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
// The native dialog must never fire: fail loudly if anything calls it.
window.confirm = (() => {
  throw new Error('native window.confirm must not be used')
}) as typeof window.confirm

declare global {
  var __featuresToasts: { kind: string; message: string }[] | undefined
  var __featuresPuts: unknown[] | undefined
}

Object.assign(globalThis, {
  __featuresToasts: [] as { kind: string; message: string }[],
  __featuresPuts: [] as unknown[],
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){},replace(){}}}export function usePathname(){return "/admin/setup/features"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__featuresToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__featuresToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { FeaturesWorkspace } = await import('./FeaturesWorkspace')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount() {
  ;(globalThis as Record<string, unknown>).__featuresToasts = []
  ;(globalThis as Record<string, unknown>).__featuresPuts = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    if (String(url) === '/api/admin/setup/features' && init?.method === 'PUT') {
      ;(globalThis.__featuresPuts as unknown[]).push(JSON.parse(String(init?.body ?? '{}')))
      return Response.json({ ok: true })
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ConfirmRoot />
        <FeaturesWorkspace
          features={[{ key: 'projects', category: 'operations', enabled: true }]}
          disableStatus={{ projects: { blocked: false, impacts: [{ labelKey: 'reconciliations', count: 2 }] } }}
        />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

test('disabling a feature with impacts confirms through the house dialog, not window.confirm', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const sw = document.body.querySelector('[role="switch"]') as HTMLElement | null
  assert.ok(sw, 'the feature row offers a switch')
  await act(async () => {
    sw.click()
    await tick()
    await tick()
  })
  const dialog = document.body.querySelector('[role="dialog"]')
  assert.ok(dialog, 'toggling off opens the house confirm dialog')
  assert.match(dialog?.textContent ?? '', /Turn off/, 'the dialog names the destructive action')
  await act(async () => {
    const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
      (b) => (b.textContent ?? '').trim() === 'Confirm',
    ) as HTMLElement | undefined
    assert.ok(confirm, 'the dialog offers Confirm')
    confirm.click()
    await tick()
    await tick()
    await tick()
  })
  assert.deepEqual(globalThis.__featuresPuts, [{ features: { projects: false } }])
})
