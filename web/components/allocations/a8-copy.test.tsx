import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../testing/jsdom-env.ts'

const { registerHooks } = await import('node:module')
const { existsSync } = await import('node:fs')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')
const worktreeUi = pathToFileURL(join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
const webRoot = join(process.cwd(), 'web')
await bootJsdomEnvironment({ url: "http://localhost:4800/admin/setup/allocations", matchMediaMatches: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') return { shortCircuit: true, url: worktreeUi }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement('a',rest,children)}",
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../messages/en')).default
const { LineagePanel } = await import('./LineagePanel.tsx')
const { DriversTab } = await import('../../app/(app)/admin/setup/allocations/drivers-tab')

const provider = (children: React.ReactElement) => (
  <NextIntlClientProvider
    locale="en"
    messages={messages}
    timeZone="UTC"
    onError={(error) => { throw error }}
  >
    {children}
  </NextIntlClientProvider>
)

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

test('the allocation driver empty state opens a manual driver with its guidance', async () => {
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => ({
    ok: true,
    json: async () => String(url).includes('/drivers')
      ? { drivers: [] }
      : { accounts: [], departments: [], locations: [], classes: [], projects: [], subsidiaries: [], books: [], periods: [], rules: [], reports: [] },
  })

  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(provider(<DriversTab />))
      await tick()
      await tick()
    })
    const newDriver = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('New driver'))
    assert.ok(newDriver, 'the empty driver registry offers a create action')
    await act(async () => {
      newDriver.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await tick()
    })
    assert.match(document.body.textContent ?? '', /Save the driver first — its effective-dated values become editable here right after\./)
    assert.doesNotMatch(document.body.textContent ?? '', /allocations\./)
  } finally {
    await act(async () => root.unmount())
  }
})

test('allocation lineage explains an empty result in the active locale', async () => {
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    ok: true,
    json: async () => ({ rows: [], total: 0, truncated: false }),
  })

  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(provider(<LineagePanel anchor={{ runId: 'run-empty' }} />))
      await tick()
      await tick()
    })

    assert.equal(document.body.textContent, 'No allocated lines trace to this record.')
    assert.doesNotMatch(document.body.textContent ?? '', /allocations\./)
  } finally {
    await act(async () => root.unmount())
  }
})
