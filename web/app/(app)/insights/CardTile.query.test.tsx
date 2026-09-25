import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'

// CardTile F4T2-1: the tile fetched POST /api/insights/query and called
// res.json before checking res.ok, so a non-JSON error body escaped the
// effect as a SyntaxError instead of failing the tile with the server's
// named refusal. The status is checked first through the shared helper.
await bootJsdomEnvironment({ url: 'http://localhost:4800/insights/dashboards/d-1' })

declare global {
  var __tileQueryImpl: (() => Promise<Response>) | undefined
}

Object.assign(globalThis, {
  __tileQueryImpl: undefined as (() => Promise<Response>) | undefined,
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
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
const messages = (await import('../../../messages/en')).default
const { CardTile } = await import('./CardTile')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const card = {
  id: 'card-1',
  name: 'Revenue trend',
  description: null,
  query: { source: 'ledger_lines', measures: [{ agg: 'count' as const }], dimensions: [], filters: [] },
  vizType: 'bar' as const,
  vizSettings: {},
}

async function mount(queryImpl?: () => Promise<Response>) {
  ;(globalThis as Record<string, unknown>).__tileQueryImpl = queryImpl
  globalThis.fetch = (async (url: unknown) => {
    if (String(url) === '/api/insights/query') {
      return (
        globalThis.__tileQueryImpl ??
        (async () => Response.json({ columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }))
      )()
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CardTile card={{ ...card }} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
  return { host, root }
}

test('a non-JSON 502 fails the tile with a named message, not a SyntaxError', async (t) => {
  const { host, root } = await mount(async () => new Response('', { status: 502 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const text = document.body.textContent ?? ''
  assert.match(text, /Query failed \(status 502\)/)
})

test('a named 422 fails the tile with the server refusal', async (t) => {
  const { host, root } = await mount(async () => Response.json({ error: 'unknown source ledger_lines' }, { status: 422 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const text = document.body.textContent ?? ''
  assert.ok(text.includes('unknown source ledger_lines'), 'the tile carries the named refusal')
})

test('a successful query renders the card without an error', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const text = document.body.textContent ?? ''
  assert.ok(text.includes('Revenue trend'), 'the tile renders the card name')
  assert.ok(!text.includes('Could not load this card'), 'success sets no error')
})
