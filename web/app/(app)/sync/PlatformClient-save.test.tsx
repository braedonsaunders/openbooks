import assert from 'node:assert/strict'
import test from 'node:test'

// F4T-2 (the connection drawer save parsed the body before checking the
// status, so a non-JSON error body hid the failure behind a SyntaxError):
// the status is checked first through the shared helper, the server's named
// refusal wins, and busy always releases.
const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/sync' })

declare global {
  var __syncToasts: { kind: string; message: string }[] | undefined
  var __syncSaveImpl: (() => Promise<Response>) | undefined
}

Object.assign(globalThis, {
  __syncToasts: [] as { kind: string; message: string }[],
  __syncSaveImpl: undefined as (() => Promise<Response>) | undefined,
})
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
    sonner:
      "export const toast={success(m){(globalThis.__syncToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__syncToasts??=[]).push({kind:'error',message:String(m)})},loading(){return 1}};export function Toaster(){return null}",
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { PlatformClient } = await import('./PlatformClient')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const sourceTypes = [
  {
    source: 'stub',
    displayName: 'Stub system',
    authKind: 'token',
    blurb: 'Stub blurb',
    configFields: [],
    secretFields: [{ key: 'token', label: 'Token' }],
    oauthSetup: null,
  },
]

async function mount() {
  ;(globalThis as Record<string, unknown>).__syncToasts = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    if (String(url) === '/api/platform/connections') {
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({ connections: [], runs: [], sourceTypes, currencies: [] })
      }
      return (globalThis.__syncSaveImpl ?? (async () => Response.json({ ok: true })))()
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlatformClient />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
  assert.ok(btn, `must offer a ${label} button`)
  return btn
}

function findSelect(scope: ParentNode): HTMLSelectElement {
  const select = scope.querySelector('select') as HTMLSelectElement | null
  assert.ok(select, 'the drawer must offer a system select')
  return select
}

async function openCreateDrawer(host: Element) {
  await act(async () => {
    findButton(host, 'Add connection').click()
    await tick()
    await tick()
  })
  const dialog = document.body
  const select = findSelect(dialog)
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')
  await act(async () => {
    descriptor?.set?.call(select, 'stub')
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
    await tick()
  })
  return dialog
}

async function clickCreate(dialog: ParentNode) {
  await act(async () => {
    findButton(dialog, 'Create connection').click()
    await tick()
    await tick()
    await tick()
  })
}

function errors(): string[] {
  return (globalThis.__syncToasts ?? []).filter((t) => t.kind === 'error').map((t) => t.message)
}

test('a non-JSON 500 on save names the failure and releases the button (F4T-2)', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__syncSaveImpl = async () => new Response('', { status: 500 })
  const dialog = await openCreateDrawer(host)
  await clickCreate(dialog)
  assert.match(errors().join('\n'), /Could not save the connection \(status 500\)/)
  assert.equal(findButton(dialog, 'Create connection').disabled, false, 'busy releases after the failure')
})

test('a named 422 on save surfaces the server refusal (F4T-2)', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__syncSaveImpl = async () =>
    Response.json({ error: 'display name is required' }, { status: 422 })
  const dialog = await openCreateDrawer(host)
  await clickCreate(dialog)
  assert.ok(errors().some((m) => m.includes('display name is required')), 'the toast carries the named refusal')
})
