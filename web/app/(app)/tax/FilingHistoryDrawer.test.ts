import assert from 'node:assert/strict'
import test from 'node:test'
import type { ComponentProps, ComponentType, ReactNode } from 'react'

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/tax' })
// The drawer's event interop needs the jsdom Event constructor identity, not
// Node's native global: keep the unconditional pin the inline block had.
;(globalThis as Record<string, unknown>).Event = window.Event

const { stubModules } = await import('../../../testing/stub-modules')
stubModules({
  navigation: 'export function useRouter(){return globalThis.__filingHistoryRouter}',
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      'export const toast={success(m){(globalThis.__filingHistoryToasts??=[]).push(String(m))},error(m){(globalThis.__filingHistoryToasts??=[]).push(String(m))}}',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { FilingHistoryDrawer } = await import('./FilingHistoryDrawer')
type TestProviderProps = Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'> & { children?: ReactNode }
const TestIntlProvider = NextIntlClientProvider as ComponentType<TestProviderProps>

const filing = {
  id: 'filing-1',
  form_name: 'GST/HST Return',
  form_code: 'CA_GST34',
  country: 'CA',
  period_from: '2026-07-01',
  period_to: '2026-07-31',
  version: 1,
  status: 'prepared' as const,
  filing_reference: null,
  filed_at: null,
  snapshot_hash: 'a'.repeat(64),
  boxes: [{ lineCode: '101', label: 'Sales', value: '1234.56', computed: true, editable: false }],
}

test('a typed filing refusal stays visible beside the action and the saved amount is formatted', async (t) => {
  const priorFetch = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Response.json({ code: 'period-not-closed', error: 'Close the period before filing.' }, { status: 409 })
  }) as typeof fetch
  ;(globalThis as typeof globalThis & { __filingHistoryRouter?: { refresh(): void }; __filingHistoryToasts?: string[] }).__filingHistoryRouter = { refresh() {} }
  ;(globalThis as typeof globalThis & { __filingHistoryToasts?: string[] }).__filingHistoryToasts = []

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(
        TestIntlProvider,
        { locale: 'en', timeZone: 'UTC', messages },
        React.createElement(FilingHistoryDrawer, { filing, closeHref: '/tax', canFile: true }),
      ),
    )
  })
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
    window.close()
  })

  const markFiled = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === messages.tax.history.markFiled)
  assert.ok(markFiled, 'a prepared filing with filing permission offers the mark-filed action')
  assert.match(document.body.textContent ?? '', /1,234\.56/)
  await act(async () => {
    markFiled.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })

  const remedy = messages.tax.history.errors.periodNotClosed
  assert.equal(document.querySelector('[role="alert"]')?.textContent, remedy)
  assert.deepEqual(calls.map(({ url, init }) => [url, init?.method]), [['/api/tax/filings/filing-1', 'PATCH']])
  assert.deepEqual((globalThis as typeof globalThis & { __filingHistoryToasts: string[] }).__filingHistoryToasts, [remedy])
})
