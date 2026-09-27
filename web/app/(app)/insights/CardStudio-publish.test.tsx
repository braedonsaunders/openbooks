import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

// CardStudio E45 (preview ~159 plus publish ~325): both fetched and called
// res.json before checking res.ok, so a non-JSON error body threw a
// SyntaxError that lost the server's named refusal. The status is checked
// first through the shared helper; busy always releases in finally.
await bootJsdomEnvironment({ url: 'http://localhost:4800/insights?card=card-1' })

declare global {
  var __studioToasts: { kind: string; message: string }[] | undefined
  var __studioPublishImpl: (() => Promise<Response>) | undefined
  var __studioQueryImpl: (() => Promise<Response>) | undefined
  var __studioDeleteImpl: (() => Promise<Response>) | undefined
  var __studioSavedPayloads: Array<Record<string, unknown>> | undefined
}

Object.assign(globalThis, {
  __studioToasts: [] as { kind: string; message: string }[],
  __studioPublishImpl: undefined as (() => Promise<Response>) | undefined,
  __studioQueryImpl: undefined as (() => Promise<Response>) | undefined,
  __studioDeleteImpl: undefined as (() => Promise<Response>) | undefined,
  __studioSavedPayloads: [] as Array<Record<string, unknown>>,
})
stubModules({
  navigation: {
    source:
      'export function useRouter(){return {refresh(){},push(){},replace(){}}}' +
      'export function usePathname(){return "/insights"}' +
      'export function useSearchParams(){return new URLSearchParams("card=card-1")}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
    sonner:
      "export const toast={success(m){(globalThis.__studioToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__studioToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { ConfirmRoot } = await import('../../../lib/confirm')
const { CardStudio } = await import('./CardStudio')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const card = {
  id: 'card-1',
  name: 'Revenue trend',
  description: null,
  query: { source: 'ledger_lines', measures: [{ agg: 'count' }], dimensions: [], filters: [] },
  viz_type: 'bar',
  viz_settings: {},
  status: 'draft',
  allowed_roles: null,
  updated_at: '2026-01-05T00:00:00.000Z',
} as const

async function mount(options?: {
  confirm?: boolean
  create?: boolean
  query?: unknown
  queryImpl?: () => Promise<Response>
  deleteImpl?: () => Promise<Response>
}) {
  ;(globalThis as Record<string, unknown>).__studioToasts = []
  ;(globalThis as Record<string, unknown>).__studioPublishImpl = undefined
  // Impls passed here win the race against the debounced preview, which
  // may fire while the mount ticks are still flushing.
  ;(globalThis as Record<string, unknown>).__studioQueryImpl = options?.queryImpl
  ;(globalThis as Record<string, unknown>).__studioDeleteImpl = options?.deleteImpl
  globalThis.__studioSavedPayloads = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    if (String(url) === '/api/insights/query') {
      return (
        globalThis.__studioQueryImpl ??
        (async () => Response.json({ columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }))
      )()
    }
    if (String(url) === '/api/insights/cards/card-1/publish') {
      return (globalThis.__studioPublishImpl ?? (async () => Response.json({ updated_at: 'x' })))()
    }
    if (String(url) === '/api/insights/cards/card-1' && init?.method === 'PATCH') {
      globalThis.__studioSavedPayloads?.push(JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>)
      return Response.json({ updated_at: '2026-02-01T00:00:00.000Z' })
    }
    if (String(url) === '/api/insights/cards/card-1' && init?.method === 'DELETE') {
      return (globalThis.__studioDeleteImpl ?? (async () => Response.json({})))()
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const studio = (
    <CardStudio
      card={{ ...card, ...(options?.query ? { query: options.query as typeof card.query } : {}) }}
      canCreate={options?.create ?? false}
      canPublish
      sourceKeys={['ledger_lines']}
      inventoryEnabled={false}
    />
  )
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {options?.confirm ? (
          <>
            <ConfirmRoot />
            {studio}
          </>
        ) : (
          studio
        )}
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

async function clickPublish(scope: ParentNode) {
  await act(async () => {
    findButton(scope, 'Publish').click()
    await tick()
    await tick()
    await tick()
  })
}

function errors(): string[] {
  return (globalThis.__studioToasts ?? []).filter((t) => t.kind === 'error').map((t) => t.message)
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
}

test('a non-JSON 500 on publish names the failure and releases the button', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__studioPublishImpl = async () => new Response('', { status: 500 })
  await clickPublish(document.body)
  assert.match(errors().join('\n'), /Update failed \(status 500\)/)
  assert.ok(findButton(document.body, 'Publish'), 'the publish button is clickable again after the failure')
})

test('a named 422 on publish surfaces the server refusal', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__studioPublishImpl = async () =>
    Response.json({ error: 'card has no measures' }, { status: 422 })
  await clickPublish(document.body)
  assert.ok(errors().some((m) => m.includes('card has no measures')), 'the toast carries the named refusal')
})

test('a successful publish toasts and flips to published', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__studioPublishImpl = async () =>
    Response.json({ updated_at: '2026-02-01T00:00:00.000Z' })
  await clickPublish(document.body)
  assert.deepEqual(errors(), [], 'success must not toast an error')
  assert.ok(
    (globalThis.__studioToasts ?? []).some(
      (toast) => toast.kind === 'success' && toast.message.includes('Card published'),
    ),
    'success toasts the publish',
  )
})

test('a non-JSON 502 on preview names the failure instead of the generic request error (E45)', async (t) => {
  const { host, root } = await mount({
    queryImpl: async () => new Response('', { status: 502 }),
  })
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  // The live preview is debounced: wait past its timer, then read the
  // preview region (rendered inline, not in a toast).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500))
  })
  const text = document.body.textContent ?? ''
  assert.match(text, /Query failed \(status 502\)/)
  assert.ok(!text.includes('Preview request failed'), 'the named refusal wins over the generic preview error')
})

test('a non-JSON 500 on delete names the failure and releases the button (F4T-16)', async (t) => {
  const { host, root } = await mount({
    confirm: true,
    create: true,
    deleteImpl: async () => new Response('', { status: 500 }),
  })
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
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
  assert.match(errors().join('\n'), /Could not delete the card \(status 500\)/)
  const del = findButton(document.body, 'Delete')
  assert.equal(del.disabled, false, 'busy releases after the failed delete')
})

test('a stored filtered formula measure survives card autosave', async (t) => {
  const measures = [
    { fn: 'sum', column: 'amount', key: 'amount', label: 'Amount', filter: { combinator: 'and', rules: [{ field: 'entry_status', op: 'eq', value: 'posted' }] } },
    { fn: 'formula', key: 'margin', label: 'Margin', expr: { op: '/', left: { ref: 'amount' }, right: { ref: 'amount' } }, format: 'ratio' },
  ]
  const { host, root } = await mount({ create: true, query: { source: 'ledger_lines', measures, dimensions: [], filters: [] } })
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  await changeInput(document.body.querySelector('input')!, 'Revenue')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)) })
  const saved = globalThis.__studioSavedPayloads?.[0] as { query: { measures: unknown[] } } | undefined
  assert.deepEqual(saved?.query.measures, measures)
})
