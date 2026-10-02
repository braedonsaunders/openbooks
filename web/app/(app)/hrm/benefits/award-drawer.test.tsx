import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import React from 'react'
import { registerHooks } from 'node:module'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/hrm/benefits', scrollIntoView: false, resizeObserver: false, event: 'jsdom' })
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
stubModules({ navigation: 'export function useRouter(){return {push(){},refresh(){}}}' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') return { shortCircuit: true, url: 'data:text/javascript,export const toast={error(message){globalThis.__benefitAwardErrors.push(message)}}' }
    return next(specifier, context)
  },
})
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const { AwardDrawer } = await import('./AwardDrawer')
const messages = Object.fromEntries(['hrm', 'common', 'ui'].map((name) => [name, JSON.parse(readFileSync(new URL(`../../../../messages/en/${name}.json`, import.meta.url), 'utf8'))]))
const drawer = { award: {
  id: 'award', programName: 'Recognition', programCode: 'THANKS', valueLabel: '$25.00', recipientLabel: 'Ada',
  periodFrom: '2026-01-01', periodTo: '2026-01-31', status: 'approved', statusLabel: 'Approved', currency: 'USD',
  programDeliveryMethod: 'payroll', externalRef: null, voidReason: null,
}, timelineEmpty: 'History retained.' } as never

async function mount(t: TestContext, content: React.ReactNode, fetcher: typeof fetch) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const previous = globalThis.fetch
  globalThis.fetch = fetcher
  ;(globalThis as Record<string, unknown>).__benefitAwardErrors = []
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = previous
  })
  await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages}>{content}</NextIntlClientProvider>))
}
async function render(t: TestContext, canQueue: boolean, fetcher: typeof fetch, record: unknown = drawer) {
  await mount(t, <AwardDrawer drawer={record as never} closeHref="/hrm/benefits" canManage canQueue={canQueue} />, fetcher)
}
async function fill(id: string, value: string) {
  await act(async () => {
    const control = document.getElementById(id)
    const node = (control?.tagName === 'BUTTON' ? control.closest('span')?.querySelector('select') : control) as HTMLInputElement
    assert.ok(node, id)
    const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
const click = async (label: string) => {
  const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  assert.ok(button, label)
  await act(async () => button.click())
}

test('HR-only award manager has no payout action and performs no pay-run lookup', async (t) => {
  let calls = 0
  await render(t, false, (async () => { calls++; throw new Error('No finance lookup expected') }) as typeof fetch)
  assert.ok(!document.body.textContent?.includes('Add to payroll'))
  assert.equal(calls, 0)
})

test('finance selects an editable scoped native run and the server refusal preserves the drawer shell', async (t) => {
  const writes: Record<string, unknown>[] = []
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/payroll/runs') return Response.json({ runs: [
      { document_id: 'open-run', document_number: 'PAY-101', document_status: 'draft', run_status: 'draft', currency: 'USD', pay_date: '2026-02-01' },
      { document_id: 'posted-run', document_number: 'PAY-099', document_status: 'posted', run_status: 'committed', currency: 'USD' },
      { document_id: 'other-currency', document_number: 'PAY-102', document_status: 'draft', run_status: 'draft', currency: 'EUR' },
    ] })
    writes.push(JSON.parse(String(init?.body)))
    return Response.json({ error: 'Choose a pay run whose pay date is on or after the award payable date.' }, { status: 422 })
  }) as typeof fetch
  await render(t, true, fetcher)
  const shell = document.querySelector('[role="dialog"]')
  assert.ok(shell)
  const findQueue = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Add to payroll')!
  await act(async () => findQueue().click())
  const select = document.querySelector('select') as HTMLSelectElement
  assert.ok(select)
  assert.deepEqual(Array.from(select.options).map((option) => option.value), ['', 'open-run'])
  await act(async () => { select.value = 'open-run'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => findQueue().click())
  assert.deepEqual(writes, [{ action: 'queue', payRunDocumentId: 'open-run' }])
  assert.equal(document.querySelector('[role="dialog"]'), shell)
  assert.deepEqual((globalThis as Record<string, unknown>).__benefitAwardErrors, ['Choose a pay run whose pay date is on or after the award payable date.'])
})

const { AwardBuilderDrawer } = await import('./AwardBuilderDrawer')

test('a fixed award carries its denomination and one request identity survives a network retry', async (t) => {
  const requests: Record<string, unknown>[] = []
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    throw new Error('Connection interrupted')
  }) as typeof fetch
  await mount(t, <AwardBuilderDrawer closeHref="/hrm/benefits" defaultCurrency="USD" programOptions={[{ value: 'program', label: 'Recognition', currency: 'USD', fixedAmount: '25.0000' }]} employmentOptions={[{ value: 'employment', label: 'Ada' }]} />, fetcher)
  await fill('award-builder-program', 'program')
  const value = document.getElementById('award-builder-value') as HTMLInputElement
  assert.equal(value.value, '25.0000')
  assert.equal(value.readOnly, true)
  assert.equal(document.getElementById('award-builder-currency')?.tagName, 'DIV')
  assert.equal(document.getElementById('award-builder-currency')?.textContent?.trim(), 'USD')
  assert.equal(document.getElementById('award-builder-currency')?.getAttribute('role'), 'status')
  await fill('award-builder-recipient', 'employment')
  await fill('award-builder-from', '2026-01-01')
  await fill('award-builder-reason', 'Recognize excellent service')
  const submit = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Create reward')!
  await act(async () => submit().click())
  await act(async () => submit().click())
  assert.equal(requests.length, 2, 'both attempts reach the domain boundary')
  assert.equal(requests[0]!.value, '25.0000')
  assert.match(String(requests[0]!.sourceKey), /^award:[0-9a-f-]{36}$/)
  assert.equal(requests[0]!.sourceKey, requests[1]!.sourceKey)
})


test('pending rewards use native Approvals rather than a local approval bypass', async (t) => {
  const seed = drawer as unknown as { award: Record<string, unknown>; timelineEmpty: string }
  await render(t, false, (async () => Response.json({ history: [], approvalState: { pendingWith: [], status: 'pending' }, neverSubmitted: false })) as typeof fetch,
    { ...seed, award: { ...seed.award, status: 'pending', approvalHref: '/approvals', flowRunId: 'native-flow' } })
  const approval = Array.from(document.querySelectorAll('a')).find((anchor) => anchor.textContent?.trim() === 'Open Approvals')
  assert.equal(approval?.getAttribute('href'), '/approvals')
  assert.ok(!Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Approve'))
})

test('external rewards queue a linked native pay run instead of inventing a fulfillment-only payout', async (t) => {
  const seed = drawer as unknown as { award: Record<string, unknown>; timelineEmpty: string }
  const writes: Record<string, unknown>[] = []
  await render(t, true, (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/payroll/runs') return Response.json({ runs: [{ document_id: 'tax-run', document_number: 'PAY-TAX', document_status: 'draft', run_status: 'draft', currency: 'USD' }] })
    writes.push(JSON.parse(String(init?.body)))
    return Response.json({ error: 'Select a non-cash earning component before queueing this reward.' }, { status: 422 })
  }) as typeof fetch, { ...seed, award: { ...seed.award, programDeliveryMethod: 'external' } })
  const queue = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Add to payroll')!
  await act(async () => queue().click())
  assert.deepEqual(writes, [], 'choosing the pay run precedes every queue mutation')
  const select = document.querySelector('select') as HTMLSelectElement
  assert.ok(select)
  await act(async () => { select.value = 'tax-run'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => queue().click())
  assert.deepEqual(writes, [{ action: 'queue', payRunDocumentId: 'tax-run' }])
  assert.deepEqual((globalThis as Record<string, unknown>).__benefitAwardErrors, ['Select a non-cash earning component before queueing this reward.'])
})


const { ProgramDrawer } = await import('./ProgramDrawer')
for (const canConfigureApprovalPolicies of [false, true]) {
  test(`approval policy editor actions follow workflow grant ${canConfigureApprovalPolicies}`, async (t) => {
    const programDrawer = {
      program: { id: 'program', name: 'Recognition', code: 'THANKS', family: 'reward', familyLabel: 'Reward', approvalMode: 'flows', status: 'closed', statusLabel: 'Closed', valueLabel: '$25', effectiveFrom: '2026-01-01', effectiveTo: null },
      policyLines: [], members: [], membersEmpty: 'No members', sources: [], sourcesEmpty: 'No sources',
      drawerRefusal: null, simulation: null, simulationRefusal: null,
      canConfigureApprovalPolicies, approvalPoliciesRefusal: null,
      approvalPolicies: { configured: true, href: '/admin/flows', policies: [{ id: 'policy', name: 'Recognition controls', ungatedOutcome: 'require_approval', href: '/admin/flows/policy' }] },
    }
    await mount(t, <ProgramDrawer drawer={programDrawer as never} closeHref="/hrm/benefits" canManage={false} employmentOptions={[]} />, (async () => { throw new Error("No policy read expected") }) as typeof fetch)
    assert.ok(document.body.textContent?.includes('Recognition controls'), 'the configured policy remains readable')
    const editorLinks = Array.from(document.querySelectorAll('a')).filter((anchor) => anchor.getAttribute('href')?.startsWith('/admin/flows'))
    assert.equal(editorLinks.length, canConfigureApprovalPolicies ? 2 : 0)
    assert.equal(document.body.textContent?.includes('Ask your company workflow administrator'), !canConfigureApprovalPolicies)
  })
}

const { ProgramBuilderDrawer } = await import('./ProgramBuilderDrawer')
const { MoneyProvider } = await import('../../../../components/money-provider')
const { emptyProgramDraft } = await import('../../../../lib/hrm/benefits-portfolio')

for (const approvalMode of ['none', 'flows'] as const) {
  test(`program approval controls default to none and persist ${approvalMode}`, async (t) => {
      const writes: Record<string, unknown>[] = []
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)))
      return Response.json({ error: 'Draft remains editable.' }, { status: 422 })
    }) as typeof fetch
    const seed = { ...emptyProgramDraft('reward'), code: 'THANKS', name: 'Recognition', currency: 'USD', effectiveFrom: '2026-01-01', fixedAmount: '25.00', capAmount: '12,34', legalEntityId: 'entity', payComponentId: 'cash-component', sourceAccountIds: [], paymentDelayDays: 0 }
    await mount(t, <MoneyProvider currency="USD"><ProgramBuilderDrawer closeHref="/hrm/benefits" initialFamily="reward" familyLocked mode="edit" programId="program" editSeed={seed as never} currencyOptions={[{value: 'USD', label: 'USD · US Dollar', scopeValue: 'entity'}]} subsidiaryOptions={[{ value: 'entity', label: 'Employer' }]} departmentOptions={[]} projectOptions={[]} accountOptions={[]} employmentsTruncated={false} canConfigureApprovalPolicies payComponentOptions={[{ value: 'cash-component', label: 'Cash reward', paymentKind: 'cash' }]} /></MoneyProvider>, fetcher)
    for (let index = 0; index < 2; index++) await click('Next')
    await click('Next')
    assert.match(document.getElementById('program-builder-capAmount-error')?.textContent ?? '', /12\.34/)
    assert.equal(writes.length, 0)
    await fill('program-builder-cap', '12.34')
    for (let index = 0; index < 2; index++) await click('Next')
    const selectControl = document.getElementById('program-builder-approvalMode')
    assert.ok(selectControl, document.body.textContent ?? '')
    const select = (selectControl.tagName === 'BUTTON' ? selectControl.closest('span')?.querySelector('select') : selectControl) as HTMLSelectElement
    assert.equal(select.value, 'none')
    assert.ok(!document.querySelector('a[href="/admin/flows"]'), 'no workflow setup action is required by the default mode')
    assert.ok(document.body.textContent?.includes('No workflow configuration or approver is required.'))
    await fill('program-builder-approvalMode', approvalMode)
    assert.equal(Boolean(document.querySelector('a[href="/admin/flows"]')), approvalMode === 'flows')
    assert.equal(document.querySelectorAll('[aria-label="Program family"]').length, 0)
    await click('Next')
    await click('Next')
    await fill('program-builder-reason', 'Update approval controls')
    await click('Save changes')
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.approvalMode, approvalMode)
  })
}

test('no-approval submission states readiness without inventing an approver or requesting a flow', async (t) => {
  const seed = drawer as unknown as { award: Record<string, unknown>; timelineEmpty: string }
  let reads = 0
  await render(t, false, (async () => { reads++; throw new Error('No workflow history exists') }) as typeof fetch, { ...seed, award: { ...seed.award, flowRunId: null, decisionSnapshot: { mode: 'not_required' } } })
  assert.ok(document.body.textContent?.includes('No approvals required. The authorized submission was recorded'))
  assert.ok(!document.querySelector('a[href="/approvals"]'))
  assert.equal(reads, 0)
})
