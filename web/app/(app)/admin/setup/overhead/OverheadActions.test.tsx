import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'

declare global {
  var __overheadActions: { errors: string[]; successes: string[]; refreshes: number }
}

const { bootJsdomEnvironment, setJsdomInput } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ event: 'jsdom' })
const { stubModules } = await import('../../../../../testing/stub-modules')
stubModules({
  navigation: 'export function useRouter(){return {refresh(){globalThis.__overheadActions.refreshes++}}}',
  extra: { sonner: 'export const toast={error(message){globalThis.__overheadActions.errors.push(message)},success(message){globalThis.__overheadActions.successes.push(message)}}' },
})
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('../../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../../components/business-date-provider')
const { OverheadActions } = await import('./OverheadActions')
const messages = Object.fromEntries(['admin', 'common', 'ui'].map(namespace => [namespace,
  JSON.parse(readFileSync(new URL(`../../../../../messages/en/${namespace}.json`, import.meta.url), 'utf8')),
]))
const copy = messages.admin.setup.entities['overhead-model']
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function mount(autoOpen: boolean, respond: (payload: Record<string, unknown>) => Promise<Response>) {
  globalThis.__overheadActions = { errors: [], successes: [], refreshes: 0 }
  const originalFetch = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, '/api/admin/setup/overhead')
    assert.equal(init?.method, 'POST')
    const payload = JSON.parse(String(init?.body))
    requests.push(payload)
    return respond(payload)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="CAD"><BusinessDateProvider today="2026-10-08">
        <OverheadActions departments={[{ id: 'department', name: 'Field', composite: 12.5 }]}
          projectTypes={[{ id: 'type', name: 'Installation' }]} autoOpen={autoOpen} />
      </BusinessDateProvider></MoneyProvider>
    </NextIntlClientProvider>)
    await tick()
  })
  return { host, requests, async close() {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = originalFetch
  } }
}

async function click(host: Element, text: string) {
  const button = [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === text)
  assert.ok(button, `the native action ${text} is available`)
  assert.equal(button.disabled, false)
  await act(async () => { button.click(); await tick() })
}

test('publication keeps edited rates on a named refusal and safely reports a proxy refusal before a deliberate retry', async () => {
  let attempt = 0
  const mounted = await mount(false, async () => ++attempt === 1
    ? Response.json({ error: 'The selected effective date is closed.', remedy: 'Choose an open accounting period.' }, { status: 409 })
    : attempt === 2 ? new Response('<html>Gateway unavailable</html>', { status: 502 }) : Response.json({ published: 1 }))
  try {
    await click(mounted.host, copy.publish)
    const dialog = mounted.host.querySelector('[role="dialog"]')!
    const rate = dialog.querySelector<HTMLInputElement>('input[type="number"]')!
    await act(async () => { setJsdomInput(rate, '37.125'); await tick() })
    await click(dialog, copy.publishConfirm)
    assert.deepEqual(__overheadActions.errors, ['The selected effective date is closed. — Choose an open accounting period.'])
    assert.equal(rate.value, '37.125')
    assert.equal(__overheadActions.refreshes, 0)
    assert.equal(__overheadActions.successes.length, 0)
    await click(dialog, copy.publishConfirm)
    assert.equal(__overheadActions.errors[1], `${copy.errors.requestFailed} (status 502)`)
    assert.equal(rate.value, '37.125')
    await click(dialog, copy.publishConfirm)
    assert.equal(mounted.host.querySelector('[role="dialog"]'), null)
    assert.equal(__overheadActions.refreshes, 1)
    assert.deepEqual(__overheadActions.successes, [copy.publishDone])
    assert.deepEqual(mounted.requests, Array.from({ length: 3 }, () => ({ action: 'publish', effectiveFrom: '2026-10-08',
      rates: [{ departmentId: 'department', ratePerHour: '37.125' }] })))
  } finally { await mounted.close() }
})

test('the wizard stops on the named policy refusal and preserves selected types and its final step', async () => {
  const mounted = await mount(true, async payload => payload.action === 'publish' ? Response.json({ published: 1 })
    : Response.json({ error: 'The project type changed while this policy was being reviewed.', remedy: 'Reload and review the current policy.' }, { status: 409 }))
  try {
    const dialog = mounted.host.querySelector('[role="dialog"]')!
    await click(dialog, copy.next)
    await click(dialog, copy.next)
    await click(dialog, copy.finish)
    assert.deepEqual(mounted.requests.map(payload => payload.action), ['publish', 'apply'])
    assert.deepEqual(mounted.requests[1]!.projectTypeIds, ['type'])
    assert.deepEqual(__overheadActions.errors, ['The project type changed while this policy was being reviewed. — Reload and review the current policy.'])
    assert.equal(__overheadActions.successes.length, 0)
    assert.equal(__overheadActions.refreshes, 0)
    assert.equal(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true)
    const finish = [...dialog.querySelectorAll('button')].find(button => button.textContent === copy.finish)!
    assert.equal(finish.disabled, false)
    assert.equal(mounted.requests.length, 2, 'a refusal does not trigger an automatic retry')
  } finally { await mounted.close() }
})
