import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment()
stubModules({ navigation: true, intl: false, authz: false, features: false, extra: {
  'next-intl': 'const t = (key, values) => values?.field ? key + ": " + values.field : key; export function useTranslations() { return t }',
  sonner: 'export const toast = { success() {}, error(message) { globalThis.__planningErrors.push(message) } }',
} })
const React = await import('react')
Object.assign(globalThis, { React, __planningErrors: [] })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { PlanningTab } = await import('./PlanningTab')
const policy = { itemId: 'item-a', leadTimeDays: 12, reviewCycleDays: 7, serviceLevel: '0.99', moqQty: '3', casePackQty: '6', preferredSupplierId: null, forecastMethod: 'seasonal', historyWeeks: 52 }

for (const failedPath of ['policies', 'suggestions']) {
  test(`${failedPath} refusal remains visible and blocks saving until retry restores the actual policy`, async (t) => {
    let refused = true
    const writes: unknown[] = []
    const oldFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return Response.json(policy) }
      if (String(input).includes(failedPath) && refused) return Response.json({ error: 'Planning access refused', remedy: 'Ask the administrator to restore inventory.plan' }, { status: 403 })
      return Response.json(String(input).includes('policies') ? [policy] : [])
    }
    const root = createRoot(document.body)
    t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = oldFetch })
    await act(async () => { root.render(React.createElement(PlanningTab, { itemId: 'item-a', subsidiaryId: 'entity-a', canManage: true, vendors: [] })) })
    assert.match(document.body.textContent ?? '', /Planning access refused/)
    assert.match(document.body.textContent ?? '', /restore inventory.plan/)
    assert.doesNotMatch(document.body.textContent ?? '', /policy.defaulted|itemTab.none/, 'a refused read cannot assert standard policy or no suggestions')
    assert.equal([...document.querySelectorAll('button')].some((b) => b.textContent === 'policy.save' && !b.disabled), false)
    assert.deepEqual(writes, [])
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'actions.retry')
    assert.ok(retry)
    refused = false
    await act(async () => retry.click())
    assert.equal((document.querySelector('input') as HTMLInputElement).value, '12')
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'policy.save')
    assert.ok(save && !save.disabled)
    await act(async () => save.click())
    assert.equal((writes[0] as { leadTimeDays: number }).leadTimeDays, 12)
    assert.equal((writes[0] as { forecastMethod: string }).forecastMethod, 'seasonal')
  })
}

test('a supplied unreadable day count refuses by field instead of saving null', async (t) => {
  const writes: unknown[] = []
  const errors: string[] = []
  ;(globalThis as unknown as { __planningErrors: string[] }).__planningErrors = errors
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return Response.json(policy) }
    return Response.json(String(input).includes('policies') ? [policy] : [])
  }
  const root = createRoot(document.body)
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = oldFetch })
  await act(async () => { root.render(React.createElement(PlanningTab, { itemId: 'item-a', subsidiaryId: 'entity-a', canManage: true, vendors: [] })) })
  const input = document.querySelector('input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, '3.5'); input.dispatchEvent(new window.Event('input', { bubbles: true })) })
  const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'policy.save')!
  await act(async () => save.click())
  assert.deepEqual(writes, [], 'nonblank unreadable count cannot clear an existing policy')
  assert.ok(errors.some((error) => error.includes('policy.leadTime')), 'refusal names the affected field')
})
