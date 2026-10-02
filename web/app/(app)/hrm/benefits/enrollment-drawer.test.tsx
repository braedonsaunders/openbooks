import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
await bootJsdomEnvironment({ url: 'http://localhost/hrm/benefits', matchMediaMatches: false, resizeObserver: false })
const { stubModules } = await import('../../../../testing/stub-modules')
const state = { replaced: [] as string[], requests: [] as Record<string, unknown>[], response: () => Response.json({ error: 'Choose an effective date after the current enrollment starts.' }, { status: 409 }) }
;(globalThis as typeof globalThis & { __enrollmentDrawerState: typeof state }).__enrollmentDrawerState = state
stubModules({ navigation: `const s=globalThis.__enrollmentDrawerState;export function useRouter(){return {push(){},replace(url){s.replaced.push(url)},refresh(){}}}export function usePathname(){return '/hrm/benefits'}export function useSearchParams(){return new URLSearchParams()}`, extra: { '@/app/(app)/accounting/changes/LossOfControlButton': 'export function LossOfControlButton(){return null}', '../../../../lib/confirm': 'export async function confirmDialog(){return true}' } })
const React = await import('react'); Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { EnrollmentDrawer } = await import('./EnrollmentDrawer')
const tick = () => new Promise(resolve => setTimeout(resolve, 15))
const record = {
  id: '00000000-0000-4000-8000-000000000001', employeeName: 'Employee', planName: 'Savings', currency: 'CAD', status: 'active', statusLabel: 'Active',
  effectiveFrom: '2026-09-27', effectiveTo: null, classKey: null, matchEligible: null, classes: [], approvalHref: null,
  rules: ['Employer', 'Employee', 'Other department'].map((label, index) => ({ value: `00000000-0000-4000-8000-00000000000${index + 2}`, label, basis: 'per_period', rate: '0', rateFormula: 'elected_rate', requiresMatchEligibility: false, effectiveFrom: '2026-09-27', effectiveTo: null })),
  terms: [2, 3].map(index => ({ ruleId: `00000000-0000-4000-8000-00000000000${index}`, electionMode: 'fixed' as const, electedRate: '100', declaredPeriodsPerYear: 52 })),
}
async function mount(t: TestContext, overrides: Partial<typeof record> = {}, manage = true, change = true) {
  state.replaced = []; state.requests = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url, init) => { state.requests.push(JSON.parse(String(init?.body))); return state.response() }) as typeof fetch
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><EnrollmentDrawer record={{ ...record, ...overrides }} closeHref="/hrm/benefits?view=employees" canManage={manage} canChange={change} /></NextIntlClientProvider>); await tick() })
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = original })
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text)
  assert.ok(button, `missing ${text}`)
  await act(async () => { button.click(); await tick() })
}
async function set(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new window.Event('input', { bubbles: true })); await tick() })
}
test('view/Edit/Cancel preserve one dialog and show only the elected contributions', async t => {
  await mount(t)
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog)
  await click('Contribution elections')
  assert.equal(document.querySelectorAll('fieldset').length, 2)
  assert.equal(document.querySelectorAll('fieldset input').length, 0)
  await click('Edit')
  assert.equal(document.querySelector('[role="dialog"]'), dialog); assert.equal(document.querySelectorAll('fieldset input').length, 2)
  await click('Cancel')
  assert.equal(document.querySelector('[role="dialog"]'), dialog); assert.equal(document.querySelectorAll('fieldset input').length, 0); assert.equal(state.requests.length, 0)
})
test('a dated change preserves the selected rules and displays the domain refusal without closing', async t => {
  await mount(t); await click('Edit')
  const dialog = document.querySelector('[role="dialog"]')
  await set(document.querySelector<HTMLInputElement>('#enrollment-change-date')!, '2026-10-05')
  await set(document.querySelector<HTMLTextAreaElement>('#enrollment-change-reason')!, 'Accepted employee election change')
  await click('Save')
  assert.equal(state.requests.length, 1)
  const payload = state.requests[0]!
  assert.equal(payload.action, 'change'); assert.equal(payload.changeDate, '2026-10-05')
  assert.deepEqual((payload.contributionTerms as { ruleId: string; declaredPeriodsPerYear: number }[]).map(term => [term.ruleId, term.declaredPeriodsPerYear]), record.terms.map(term => [term.ruleId, 52]))
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /Choose an effective date/)
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(state.replaced.length, 0)
})
test('same-start changes are refused before any write', async t => {
  await mount(t); await click('Edit')
  await set(document.querySelector<HTMLInputElement>('#enrollment-change-date')!, record.effectiveFrom)
  await set(document.querySelector<HTMLTextAreaElement>('#enrollment-change-reason')!, 'Correction')
  await click('Save')
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /after 2026-09-27/)
  assert.equal(state.requests.length, 0)
})
test('readers and ended history cannot edit or end coverage', async t => {
  await mount(t, { status: 'ended', statusLabel: 'Ended' }, false)
  assert.equal([...document.querySelectorAll('button')].some(node => ['Edit', 'Actions', 'Save'].includes(node.textContent?.trim() ?? '')), false)
  await click('Contribution elections')
  assert.equal(document.querySelectorAll('fieldset input').length, 0)
})
test('an inactive plan protects edits while retaining the active enrollment End action', async t => {
  await mount(t, {}, true, false)
  assert.equal([...document.querySelectorAll('button')].some(node => node.textContent?.trim() === 'Edit'), false)
  await click('Actions'); await click('End enrollment')
  assert.ok(document.querySelector<HTMLTextAreaElement>('#enrollment-change-reason'))
  assert.equal(document.querySelectorAll('fieldset input').length, 0)
})

test('coverage without contribution rules permits a dated class change without inventing amounts', async t => {
  await mount(t, { rules: [], terms: [] }); await click('Edit'); await set(document.querySelector<HTMLInputElement>('#enrollment-change-date')!, '2026-10-05'); await set(document.querySelector<HTMLTextAreaElement>('#enrollment-change-reason')!, 'Eligibility change'); await click('Save');
  assert.equal(state.requests.length, 1); assert.equal(state.requests[0]!.contributionTerms, undefined);
});
