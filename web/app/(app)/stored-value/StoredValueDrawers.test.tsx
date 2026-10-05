import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ matchMediaMatches: false })
stubModules({ navigation: true, intl: false, extra: {
  sonner: 'export const toast = { success(message) { globalThis.__storedSuccess.push(message) }, error(message) { globalThis.__storedErrors.push(message) } }',
} })
const React = await import('react')
Object.assign(globalThis, { React, __storedSuccess: [], __storedErrors: [] })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { StoredValueIssueDrawer, StoredValueDrawer } = await import('./StoredValueDrawers')
const accountId = '01a10c33-abb8-797a-bd5a-058e59065554'
const issue = { programs: [{ id: 'program', name: 'Gift cards', kind: 'gift_card', kindLabel: 'Gift card', currency: 'USD' }], customers: [], debitAccounts: [{ id: 'cash', name: 'Cash' }], subsidiaries: [{ id: 'entity-hq', name: 'HQ' }], closeHref: '/stored-value' }
const errors = () => (globalThis as unknown as { __storedErrors: string[] }).__storedErrors
const successes = () => (globalThis as unknown as { __storedSuccess: string[] }).__storedSuccess
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  assert.ok(button, `expected reachable ${label}`)
  await act(async () => button.click())
}
async function input(id: string, value: string) {
  const node = document.getElementById(id) as HTMLInputElement
  assert.ok(node)
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new window.Event('input', { bubbles: true })) })
}
async function mount(element: React.ReactNode, t: { after: (fn: () => Promise<void>) => void }) {
  errors().length = 0; successes().length = 0
  const root = createRoot(document.body)
  t.after(async () => { await act(async () => root.unmount()) })
  await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{element}</NextIntlClientProvider>))
}

test('issue retry preserves the applied intent and a replay names the existing account without inventing a code', async t => {
  const oldFetch = globalThis.fetch
  const keys: string[] = []; const effects = new Set<string>()
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body))
    const key = payload.idempotencyKey
    keys.push(key); const prior = effects.has(key); effects.add(key)
    assert.equal(payload.subsidiaryId, 'entity-hq', 'the issue must name its visible issuing entity')
    if (keys.length === 1) throw new Error('Response lost after issue')
    return Response.json({ accountId, code: prior ? null : 'second-card-code', replayed: prior })
  }
  t.after(async () => { globalThis.fetch = oldFetch })
  await mount(<StoredValueIssueDrawer issue={issue} />, t)
  await input('sv-issue-amount', '25.00'); await click(messages.storedValue.issue.submit)
  assert.match(errors().join(), /Response lost/)
  assert.ok((document.getElementById('sv-issue-amount') as HTMLInputElement).disabled, 'uncertain receipt must keep the financial intent unchanged')
  await click(messages.storedValue.issue.submit)
  assert.equal(effects.size, 1, 'response loss cannot issue a second account')
  assert.equal(keys[0], keys[1])
  assert.ok(document.querySelector(`a[href="/stored-value?account=${accountId}"]`), 'replay must lead to the account already issued')
  assert.doesNotMatch(document.body.textContent ?? '', /second-card-code|\bnull\b/)
  assert.equal(document.getElementById('sv-issue-amount'), null, 'confirmed replay cannot offer another issue')
})

test('an incomplete issue receipt keeps the original intent available for retry', async t => {
  const oldFetch = globalThis.fetch; const keys: string[] = []
  globalThis.fetch = async (_url, init) => { keys.push(JSON.parse(String(init?.body)).idempotencyKey); return Response.json({}) }
  t.after(async () => { globalThis.fetch = oldFetch })
  await mount(<StoredValueIssueDrawer issue={issue} />, t)
  await input('sv-issue-amount', '25.00'); await click(messages.storedValue.issue.submit)
  assert.ok(document.getElementById('sv-issue-amount'), 'unknown receipt is not an issued-code confirmation')
  assert.ok(errors().length > 0, 'unknown receipt must name a retry remedy')
  await click(messages.storedValue.issue.submit)
  assert.equal(keys[0], keys[1])
  assert.doesNotMatch(document.body.textContent ?? '', /undefined/)
})

test('clipboard refusal leaves the issued code visible and never reports that it was copied', async t => {
  const oldFetch = globalThis.fetch; const oldClipboard = navigator.clipboard
  globalThis.fetch = async () => Response.json({ accountId, code: 'visible-once-code', replayed: false })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied') } } })
  t.after(async () => { globalThis.fetch = oldFetch; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: oldClipboard }) })
  await mount(<StoredValueIssueDrawer issue={issue} />, t)
  await input('sv-issue-amount', '25.00'); await click(messages.storedValue.issue.submit)
  const copy = document.querySelector('[aria-label] section button, section button') as HTMLButtonElement
  assert.ok(copy)
  await act(async () => copy.click())
  assert.match(document.body.textContent ?? '', /visible-once-code/)
  assert.deepEqual(successes(), [], 'permission refusal cannot report copied')
  assert.ok(errors().length > 0)
})

test('adjustment keeps its intent through response loss and tab changes, then clears a confirmed draft', async t => {
  const oldFetch = globalThis.fetch; const keys: string[] = []; const effects = new Set<string>()
  globalThis.fetch = async (_url, init) => {
    const key = JSON.parse(String(init?.body)).idempotencyKey; keys.push(key); effects.add(key)
    if (keys.length === 1) throw new Error('Response lost after adjustment')
    return Response.json({ entryId: accountId, journalEntryId: accountId, balanceMinor: '350000' })
  }
  t.after(async () => { globalThis.fetch = oldFetch })
  await mount(<StoredValueDrawer drawer={{ remountKey: accountId, account: { id: accountId, kind: 'gift_card', kindLabel: 'Gift card', codeLast4: '1042', customerName: null, currency: 'USD', subsidiaryName: 'HQ', functionalCurrency: 'USD', issuedDisplay: '25.00 USD', balanceDisplay: '25.00 USD', balanceFunctionalDisplay: '25.00 USD', breakageDisplay: '0.00 USD', status: 'active', statusLabel: 'Active', expiresOn: null, lastActivityOn: '2026-10-05' }, program: null, entries: [], offsetAccounts: [{ id: 'cash', name: 'Cash' }], canManage: false, canAdjust: true, closeHref: '/stored-value' }} />, t)
  await click(messages.storedValue.drawer.adjust)
  await input('sv-adjust-amount', '10.00'); await input('sv-adjust-reason', 'Correct opening balance')
  const picker = document.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement
  assert.ok(picker); await act(async () => picker.click())
  const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes('Cash')) as HTMLElement
  assert.ok(option); await act(async () => option.click())
  const save = () => [...document.querySelectorAll('button')].filter(b => b.textContent === messages.storedValue.drawer.adjust).at(-1)!
  await act(async () => save().click())
  await click(messages.storedValue.drawer.ledgerTitle); await click(messages.storedValue.drawer.adjust)
  assert.equal((document.getElementById('sv-adjust-amount') as HTMLInputElement).value, '10.00')
  await act(async () => save().click())
  assert.equal(effects.size, 1); assert.equal(keys[0], keys[1])
  assert.equal((document.getElementById('sv-adjust-amount') as HTMLInputElement).value, '')
  assert.ok(save().disabled, 'a confirmed draft cannot immediately apply again')
})
