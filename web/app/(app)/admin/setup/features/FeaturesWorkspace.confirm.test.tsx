import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/setup/features', scrollIntoView: false })
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
const { stubModules } = await import('../../../../../testing/stub-modules')
// The Projects tab is selected by URL, exactly as the tab strip links it.
stubModules({
  navigation: {
    source:
      'export function useRouter(){return{push(){},refresh(){},replace(){},back(){},forward(){}}}' +
      "export function usePathname(){return '/admin/setup/features'}" +
      "export function useSearchParams(){return new URLSearchParams('tab=projects')}",
  },
})
registerHooks({
  resolve(specifier, context, next) {

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
          features={['projects', 'timeTracking', 'fieldTime'].map(
            (key, index, keys) => ({ key, category: 'projects', enabled: true, ...(index ? { parentKey: keys[index - 1] } : {}) }),
          )}
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
  const nested = document.querySelector('[aria-label="Field time capture"]')?.closest('.flex.items-start') as HTMLElement | null
  assert.equal(nested?.style.paddingLeft, '40px')
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
