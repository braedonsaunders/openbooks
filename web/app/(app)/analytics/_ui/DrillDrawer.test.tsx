import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'

// The drill drawer averages and shares exact API money strings: the average
// divides the decimal total by the count, and each breakdown share divides
// exact amounts — never a float hop that loses cents on large ledgers.

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics/vendor-performance', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__ddRouter}export function usePathname(){return \'/analytics/vendor-performance\'}export function useSearchParams(){return new URLSearchParams()}' })

declare global {
  var __ddRouter: { push(url: string): void; refresh(): void } | undefined
}

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { DrillDrawer } = await import('./DrillDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

// Exact decimal fixture: total 1000.00 across 3 transactions, one document
// type holding exactly half.
function stubDrillFetch() {
  const prior = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({
      mode: 'party',
      total: '1000.00',
      count: 3,
      entries: [
        {
          date: '2026-07-05',
          entryId: 'e1',
          docId: null,
          docKind: 'customer_invoice',
          docNumber: 'INV-1',
          label: 'Acme Corp',
          memo: '',
          amount: '1000.00',
        },
      ],
      monthly: [],
      breakdown: [{ name: 'customer_invoice', amount: '500.00', count: 2 }],
    })) as typeof fetch
  return () => {
    globalThis.fetch = prior
  }
}

function providers(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">{ui}</MoneyProvider>
    </NextIntlClientProvider>
  )
}

async function openDrawer() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      providers(
        <DrillDrawer
          target={{ kind: 'party', id: 'p-1', name: 'Acme Corp' }}
          from="2026-07-01"
          to="2026-07-31"
          onClose={() => {}}
        />,
      ),
    )
    await tick()
  })
  await tick()
  await tick()
  return {
    text: () => document.body.textContent ?? '',
    close: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

test('the drill average divides the exact total by the count', async () => {
  globalThis.__ddRouter = { push() {}, refresh() {} }
  const restoreFetch = stubDrillFetch()
  const drawer = await openDrawer()
  try {
    // 1000.00 ÷ 3 = 333.33… — compact money shows the exact quotient as $333
    // next to the Avg label (a divisor off by one would read $250).
    assert.match(drawer.text(), /\$333Avg/, `the average must be $333, got:\n${drawer.text()}`)
  } finally {
    await drawer.close()
    restoreFetch()
  }
})

test('a breakdown share divides exact amounts', async () => {
  globalThis.__ddRouter = { push() {}, refresh() {} }
  const restoreFetch = stubDrillFetch()
  const drawer = await openDrawer()
  try {
    const byType = [...document.querySelectorAll('button')].find((b) => b.textContent === 'By Type')
    assert.ok(byType, 'the breakdown view must exist')
    await click(byType)
    // 500.00 of 1000.00 is exactly one half.
    assert.ok(drawer.text().includes('50.0%'), `the share must be 50.0%, got:\n${drawer.text()}`)
  } finally {
    await drawer.close()
    restoreFetch()
  }
})
