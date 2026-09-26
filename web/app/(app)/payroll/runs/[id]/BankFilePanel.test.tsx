import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../../testing/jsdom-env'
import { stubModules } from '../../../../../testing/stub-modules'

// C-11: a failed bank-file GET left `state` null, and `if (!state) return
// null` rendered exactly like loading — forever. Loading, error (named, with
// retry) and loaded are now three distinct states.

await bootJsdomEnvironment({ url: 'http://localhost:4800/payroll/runs/fixture' })

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner: 'export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
  },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { BankFilePanel } = await import('./BankFilePanel')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const loadedState = {
  entitlement: { entitled: true, refusal: null, runStatus: 'calculated', currency: 'USD', payDate: '2026-07-21' },
  population: null,
  profiles: [],
  artifacts: [],
  audit: [],
  formats: {},
}

let bankFileStatus = 200
let bankFileBody: unknown = loadedState

async function mountPanel(t: TestContext): Promise<void> {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url === '/api/payroll/runs/fixture/bank-file') {
      return new Response(JSON.stringify(bankFileBody), {
        status: bankFileStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = priorFetch
  })
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BankFilePanel documentId="fixture" canRun={false} fmt={(v) => String(v ?? '')} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

test('a failing bank-file fetch shows a named error with a retry, not the loading state', async (t) => {
  bankFileStatus = 500
  bankFileBody = { error: 'database is down' }
  await mountPanel(t)
  assert.ok(
    bodyText().includes('database is down'),
    `the named failure must surface, got: ${bodyText().slice(0, 200)}`,
  )
  const retry = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Retry'))
  assert.ok(retry, 'the error state offers a retry')
})

test('the retry recovers into the loaded panel', async (t) => {
  bankFileStatus = 500
  bankFileBody = { error: 'database is down' }
  await mountPanel(t)
  const retry = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Retry'),
  ) as HTMLButtonElement | undefined
  assert.ok(retry, 'the error state offers a retry')
  bankFileStatus = 200
  bankFileBody = loadedState
  await act(async () => {
    retry.click()
    await tick()
    await tick()
  })
  assert.ok(bodyText().includes('Direct deposit'), `the panel loads after retry, got: ${bodyText().slice(0, 200)}`)
  assert.ok(!bodyText().includes('database is down'), 'the failure clears after retry')
})

test('a healthy fetch renders the loaded panel, not the loading state', async (t) => {
  bankFileStatus = 200
  bankFileBody = loadedState
  await mountPanel(t)
  assert.ok(bodyText().includes('Direct deposit'))
  assert.ok(!bodyText().includes('Loading direct-deposit'))
})
