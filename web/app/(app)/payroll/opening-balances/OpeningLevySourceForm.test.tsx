import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'
import type { readOpeningLevySourceContext } from '@openbooks/engine/payroll/opening-levy-source-authority'

await bootJsdomEnvironment({ url: 'http://localhost:4800/payroll/opening-balances' })
stubModules({
  intl: false,
  extra: { sonner: 'export const toast={success(){},error(){},info(){}};export function Toaster(){return null}' },
})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { OpeningLevySourceForm } = await import('./OpeningLevySourceForm')
type Context = Awaited<ReturnType<typeof readOpeningLevySourceContext>>
type Props = React.ComponentProps<typeof OpeningLevySourceForm>
const employeePartyId = '10000000-0000-4000-8000-000000000001'
const openingBalanceId = '10000000-0000-4000-8000-000000000002'
const einId = '10000000-0000-4000-8000-000000000003'
const sha = 'a'.repeat(64)
function source(country = 'US'): Context {
  return {
    record: {
      openingBalanceId, employeePartyId, taxYear: 2026, openingSha256: sha,
      employerAuthorityId: '10000000-0000-4000-8000-000000000004',
      subsidiaryId: '10000000-0000-4000-8000-000000000005', country,
      sourceFileId: '10000000-0000-4000-8000-000000000006',
      sourceVersionId: '10000000-0000-4000-8000-000000000007',
      sourceSha256: 'b'.repeat(64), sourceReference: 'Original payroll report, employee 42',
      levyAuthorityId: null, levyReason: null, allocationSha256: null, sealed: null, levyMatches: null,
    },
    allocations: [], eins: [{ id: einId, name: 'Original EIN', isActive: false }],
    suiAccounts: [], openingSuiStates: [], openingSuiAccountIds: [],
  }
}
const props: Props = { employeePartyId, year: 2026, openingAmounts: {}, canManage: true, annualDirty: false, onSaved() {} }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function stubFetch(t: TestContext, handler: typeof fetch) {
  const previous = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => { globalThis.fetch = previous })
}
async function mount(t: TestContext, initial = props) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let live = true
  const unmount = async () => { if (live) { live = false; await act(async () => root.unmount()); host.remove() } }
  t.after(unmount)
  const render = async (next: Props) => act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><OpeningLevySourceForm {...next} /></NextIntlClientProvider>))
  await render(initial)
  return { render, unmount }
}
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent === label)
  assert.ok(found, `the ${label} action is available`)
  return found
}
async function click(label: string) { await act(async () => button(label).click()) }
async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null
  assert.ok(input, `${id} is available`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
function input(id: string) { return document.getElementById(id) as HTMLInputElement }
const seal = 'Seal statutory opening allocations'

test('submits exact retained record, fingerprint and explicit operator amount without profile inference', async t => {
  const posts: Record<string, unknown>[] = []
  const queries: URLSearchParams[] = []
  let saved = 0
  stubFetch(t, async (url, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return Response.json({ error: 'The retained source file version is unavailable. Restore it in File Cabinet.' }, { status: 422 })
    }
    queries.push(new URL(String(url), 'http://localhost').searchParams)
    return Response.json(source())
  })
  await mount(t, { ...props, onSaved() { saved += 1 } })
  assert.equal(queries[0]!.get('employeePartyId'), employeePartyId)
  assert.equal(queries[0]!.get('taxYear'), '2026')
  assert.ok(document.body.textContent?.includes(source().record!.sourceVersionId!))
  assert.ok(document.body.textContent?.includes(source().record!.sourceSha256!))
  assert.match(document.body.textContent!, /does not record independent proof of original country, currency or coverage completeness/)
  assert.equal(input('levy-source-0-amount').value, '')
  assert.equal(button(seal).disabled, true)
  await type('levy-source-0-amount', '0')
  await type('levy-source-reason', 'Verified original report')
  await click(seal)
  assert.deepEqual(posts, [{
    openingBalanceId, expectedOpeningSha256: sha,
    allocations: [{ programKey: 'us_futa', region: 'US', filingAccountId: einId, amount: '0' }],
    reason: 'Verified original report',
  }])
  assert.equal(saved, 0)
  assert.match(document.body.textContent!, /Restore it in File Cabinet/)
  assert.equal(input('levy-source-0-amount').value, '0')
  assert.equal(input('levy-source-reason').value, 'Verified original report')
  await click('Reload retained source')
  assert.equal(input('levy-source-0-amount').value, '0')
  assert.equal(input('levy-source-reason').value, 'Verified original report')
})

test('all Canadian declarations require explicit amounts and missing aggregate totals stay unavailable', async t => {
  stubFetch(t, async () => Response.json(source('CA')))
  await mount(t)
  const amounts = [...document.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')]
  assert.equal(amounts.length, 18)
  assert.ok(amounts.every(field => field.value === ''))
  assert.match(document.body.textContent!, /WCB total: Not available/)
  await type('levy-source-reason', 'Verified all provinces')
  for (let index = 0; index < amounts.length - 1; index++) await type(`levy-source-${index}-amount`, '0')
  assert.equal(button(seal).disabled, true)
  await type('levy-source-17-amount', '0')
  assert.equal(button(seal).disabled, false)
})

test('read-only permission disables amount, reason, add and remove controls', async t => {
  stubFetch(t, async () => Response.json(source()))
  await mount(t, { ...props, canManage: false })
  assert.ok([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].every(node => node.disabled))
  for (const label of ['Remove', 'Add SUI state', 'Add PA LST worksite']) assert.equal(button(label).disabled, true)
  assert.ok(![...document.querySelectorAll('button')].some(node => node.textContent === seal))
})

test('a sealed source hydrates retained allocations without mutable controls or amendment advice', async t => {
  const context = source()
  context.record = { ...context.record!, levyAuthorityId: '10000000-0000-4000-8000-000000000008', sealed: true, levyMatches: true, levyReason: 'Report verified', allocationSha256: 'c'.repeat(64) }
  context.allocations = [{ programKey: 'us_futa', region: 'US', subRegion: '', filingAccountId: einId, amount: '415.1200' }]
  stubFetch(t, async () => Response.json(context))
  await mount(t)
  assert.equal(document.querySelectorAll('input, select').length, 0)
  assert.match(document.body.textContent!, /415\.1200/)
  assert.match(document.body.textContent!, /cannot amend or replace the seal/)
  assert.ok(document.body.textContent?.includes(context.record.allocationSha256!))
})

test('wrong employee or year response refuses hydration and save', async t => {
  const context = source()
  context.record = { ...context.record!, taxYear: 2025 }
  stubFetch(t, async () => Response.json(context))
  await mount(t)
  assert.match(document.body.textContent!, /does not match this employee and year/)
  assert.equal(document.querySelectorAll('input').length, 0)
})

test('an earlier employee response cannot overwrite the newly selected employee', async t => {
  const first = deferred<Response>()
  const second = deferred<Response>()
  let requests = 0
  stubFetch(t, async () => (++requests === 1 ? first.promise : second.promise))
  const view = await mount(t)
  const nextEmployee = '10000000-0000-4000-8000-000000000009'
  await view.render({ ...props, employeePartyId: nextEmployee, year: 2027 })
  const nextContext = source()
  nextContext.record = { ...nextContext.record!, employeePartyId: nextEmployee, taxYear: 2027 }
  await act(async () => second.resolve(Response.json(nextContext)))
  await type('levy-source-0-amount', '72.0001')
  await act(async () => first.resolve(Response.json(source('CA'))))
  assert.equal(input('levy-source-0-amount').value, '72.0001')
  assert.ok(document.body.textContent?.includes(nextEmployee))
  assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length, 1)
})

test('a changed retained opening keeps the draft and blocks sealing until it is discarded', async t => {
  let context = source()
  stubFetch(t, async () => Response.json(context))
  await mount(t)
  await type('levy-source-0-amount', '18.25')
  await type('levy-source-reason', 'Original report')
  context = { ...context, record: { ...context.record!, openingSha256: 'd'.repeat(64) } }
  await click('Reload retained source')
  assert.equal(input('levy-source-0-amount').value, '18.25')
  assert.equal(button(seal).disabled, true)
  assert.match(document.body.textContent!, /draft is preserved/)
  await click('Discard draft and reload')
  assert.equal(input('levy-source-0-amount').value, '')
  assert.equal(input('levy-source-reason').value, '')
})

test('a load refusal preserves entries and a successful retry restores their editability', async t => {
  let refuse = false
  stubFetch(t, async () => refuse ? Response.json({ error: 'Source is outside your payroll authority' }, { status: 422 }) : Response.json(source()))
  await mount(t)
  await type('levy-source-0-amount', '45.0001')
  refuse = true
  await click('Reload retained source')
  assert.equal(input('levy-source-0-amount').value, '45.0001')
  assert.equal(input('levy-source-0-amount').disabled, true)
  assert.match(document.body.textContent!, /outside your payroll authority/)
  refuse = false
  await click('Retry')
  assert.equal(input('levy-source-0-amount').value, '45.0001')
  assert.equal(input('levy-source-0-amount').disabled, false)
})

test('save completion after unmount does not notify the newly selected record', async t => {
  const pending = deferred<Response>()
  let saved = 0
  const capture: { signal?: AbortSignal | null } = {}
  stubFetch(t, async (_url, init) => {
    if (init?.method === 'POST') { capture.signal = init.signal; return pending.promise }
    return Response.json(source())
  })
  const view = await mount(t, { ...props, onSaved() { saved++ } })
  await type('levy-source-0-amount', '0')
  await type('levy-source-reason', 'Original source verified')
  await click(seal)
  await view.unmount()
  assert.equal(capture.signal?.aborted, true)
  await act(async () => pending.resolve(Response.json({ record: { id: 'sealed' } })))
  assert.equal(saved, 0)
})

test('unknown employer country cannot borrow the employee profile or render allocations', async t => {
  const context = source()
  context.record = { ...context.record!, country: null }
  stubFetch(t, async () => Response.json(context))
  await mount(t)
  assert.equal(document.querySelectorAll('input').length, 0)
  assert.match(document.body.textContent!, /supports Canadian and US employer configurations only/)
})
