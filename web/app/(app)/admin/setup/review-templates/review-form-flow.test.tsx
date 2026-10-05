import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { bootJsdomEnvironment } from '../../../../../testing/jsdom-env'
import { stubModules } from '../../../../../testing/stub-modules'

const pushes: string[] = []
const routerKey = Symbol.for('openbooks.review-form.test-router')
;(globalThis as unknown as Record<symbol, unknown>)[routerKey] = { push: (href: string) => pushes.push(href), refresh() {} }
stubModules({ navigation: {
  pathname: '/hrm/performance/templates',
  routerSource: `export function useRouter(){return globalThis[Symbol.for('openbooks.review-form.test-router')]}`,
} })
await bootJsdomEnvironment({ event: 'jsdom' })
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const { ReviewTemplateIndex } = await import('./ReviewTemplateIndex')
const { ReviewTemplateCreateForm } = await import('./ReviewTemplateCreateForm')
const { CycleCreateForm } = await import('../../../hrm/performance/CycleCreateForm')
const { DirtyUrlDrawer } = await import('../../../../../components/dirty-url-drawer')
const { ConfirmRoot } = await import('../../../../../lib/confirm')
const { ViewTabsProvider } = await import('../../../../../components/module-home/navigation-context')
const messages = Object.fromEntries(['admin', 'hrm', 'common', 'ui', 'shell'].map((namespace) => [namespace, JSON.parse(readFileSync(new URL(`../../../../../messages/en/${namespace}.json`, import.meta.url), 'utf8'))]))
const fetchBefore = globalThis.fetch
const templateId = '11111111-1111-4111-8111-111111111111'

test.after(() => { globalThis.fetch = fetchBefore; window.close() })
async function mount(component: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages}>{component}</NextIntlClientProvider>) })
  return async () => { await act(async () => root.unmount()); host.remove() }
}
async function enter(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement
  assert.ok(input, id)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function completeForm() {
  await enter('new-review-name', 'Annual review')
  for (const label of ['Developing', 'Meeting', 'Exceeding']) {
    await enter('new-review-labels', label)
    await act(async () => { document.getElementById('new-review-labels')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  }
}
async function submitForm() {
  await act(async () => { document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
}

test('the form catalog keeps creation, editing, and the shared navigation in Performance', async () => {
  const unmount = await mount(<ViewTabsProvider groups={[[{ href: '/hrm/performance', label: 'Cycles' }, { href: '/hrm/performance/templates', label: 'Review forms' }, { href: '/hrm/performance?tab=succession', label: 'Succession plans' }]]}><ReviewTemplateIndex basePath="/hrm/performance/templates" templates={[{ id: templateId, name: 'Annual review', isActive: true, scaleMin: '1', scaleMax: '5', sectionCount: 1, questionCount: 1, cycleCount: 0 }]} /></ViewTabsProvider>)
  try {
    assert.equal(document.querySelector('h1')?.textContent, 'Review forms')
    assert.equal(document.querySelectorAll('a[href="/hrm/performance/templates?template=new"]').length, 1)
    assert.ok(document.querySelector(`a[href="/hrm/performance/templates/${templateId}"]`))
    assert.ok(document.querySelector('[data-page-actions] a[href="/hrm/performance?tab=succession"]'), 'shared tabs belong in the header action rail')
  } finally { await unmount() }
})

test('creating a form sends its declared scale through the canonical writer and opens its native builder', async () => {
  pushes.length = 0
  let request: { url: string; body: Record<string, unknown>; headers: Headers } | undefined
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) }
    return Response.json({ id: templateId }, { status: 201 })
  }
  const unmount = await mount(<ReviewTemplateCreateForm basePath="/hrm/performance/templates" />)
  try {
    await completeForm()
    await submitForm()
    assert.equal(request?.url, '/api/admin/setup/hrm-review-templates')
    assert.deepEqual(request?.body, { name: 'Annual review', ratingScaleMin: '1', ratingScaleMax: '5', ratingScaleLabels: ['Developing', 'Meeting', 'Exceeding'], isActive: true })
    assert.ok(request?.headers.get('Idempotency-Key'))
    assert.deepEqual(pushes, [`/hrm/performance/templates/${templateId}`])
  } finally { await unmount() }
})

test('a refused create remains in the same drawer with the server remedy and entered values', async () => {
  pushes.length = 0
  globalThis.fetch = async () => Response.json({ error: 'The scale maximum must exceed its minimum. Correct the scale bounds.' }, { status: 400 })
  const unmount = await mount(<ReviewTemplateCreateForm basePath="/hrm/performance/templates" />)
  try {
    const shell = document.querySelector('[role="dialog"]')
    assert.ok(shell)
    await completeForm()
    await submitForm()
    assert.equal(document.querySelector('[role="dialog"]'), shell)
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'The scale maximum must exceed its minimum. Correct the scale bounds.')
    assert.equal((document.getElementById('new-review-name') as HTMLInputElement).value, 'Annual review')
    assert.deepEqual(pushes, [])
  } finally { await unmount() }
})

test('a cycle without forms offers direct creation only to an authorized operator', async () => {
  const props = { closeHref: '/hrm/performance', templates: [], emptyTemplates: 'Create a review form first.', templateLabel: 'Review form', nameLabel: 'Name', startLabel: 'Start', endLabel: 'End', submitLabel: 'Create cycle', cancelLabel: 'Cancel', setupHint: 'New review form', setupHref: '/hrm/performance/templates?template=new', failed: 'Could not create cycle.' }
  let unmount = await mount(<DirtyUrlDrawer open title="New cycle" closeHref={props.closeHref}><CycleCreateForm {...props} /></DirtyUrlDrawer>)
  try {
    assert.ok(document.querySelector('a[href="/hrm/performance/templates?template=new"]'))
    const save = document.querySelector('form button[type=submit]') as HTMLButtonElement | null
    assert.ok(save, 'The native cycle form exposes its draft save action')
    assert.equal(save.disabled, true, 'A missing review form cannot create a cycle')
  } finally { await unmount() }
  unmount = await mount(<DirtyUrlDrawer open title="New cycle" closeHref={props.closeHref}><CycleCreateForm {...props} setupHref={null} /></DirtyUrlDrawer>)
  try { assert.equal(document.querySelector('a[href="/hrm/performance/templates?template=new"]'), null) } finally { await unmount() }
})


test('leaving a cycle draft for form creation asks before discarding and respects cancellation', async () => {
  pushes.length = 0
  const props = { closeHref: '/hrm/performance', templates: [{ value: templateId, label: 'Annual review' }], initialTemplateId: templateId, emptyTemplates: 'Create a review form first.', templateLabel: 'Review form', nameLabel: 'Name', startLabel: 'Start', endLabel: 'End', submitLabel: 'Create cycle', cancelLabel: 'Cancel', setupHint: 'New review form', setupHref: '/hrm/performance/templates?template=new', failed: 'Could not create cycle.' }
  const unmount = await mount(<><ConfirmRoot /><DirtyUrlDrawer open title="New cycle" closeHref={props.closeHref}><CycleCreateForm {...props} /></DirtyUrlDrawer></>)
  try {
    assert.equal((document.querySelector('select[aria-hidden]') as HTMLSelectElement).value, templateId, 'a cycle started from the builder uses that form')
    await enter('cycle-name', 'Annual cycle')
    await act(async () => { (document.querySelector('a[href="/hrm/performance/templates?template=new"]') as HTMLAnchorElement).click() })
    assert.deepEqual(pushes, [])
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'Cancel' && button.closest('[role="dialog"]')?.textContent?.includes('unsaved'))
    assert.ok(cancel, 'the shared confirmation offers cancellation')
    await act(async () => cancel.click())
    assert.deepEqual(pushes, [])
    assert.equal((document.getElementById('cycle-name') as HTMLInputElement).value, 'Annual cycle')
  } finally { await unmount() }
})
