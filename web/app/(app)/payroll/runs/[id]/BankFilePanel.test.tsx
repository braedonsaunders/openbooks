import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// C-11: a failed bank-file GET left `state` null, and `if (!state) return
// null` rendered exactly like loading — forever. Loading, error (named, with
// retry) and loaded are now three distinct states.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/runs/fixture',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
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
