import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { bootJsdomEnvironment } from '../testing/jsdom-env'
import { stubModules } from '../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/admin/setup/payroll?tab=compensation-packages&package=10000000-0000-4000-8000-000000000003', matchMediaMatches: false, event: 'jsdom' })
Object.assign(globalThis, { __aggregateRouter: { push() {}, replace() {}, refresh() {}, prefetch() {} } })
stubModules({ navigation: { source: 'export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return globalThis.__aggregateRouter}' }, intl: false, authz: false, features: false })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/link') return { shortCircuit: true, url: 'data:text/javascript,export default function Link(props){return props.children}' }
  if (specifier === 'sonner') return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(){},error(){}}' }
  return next(specifier, context)
} })
const React = await import('react'); Object.assign(globalThis, { React })
const { act } = React, { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { MoneyProvider } = await import('./money-provider')
const { SetupDrawer } = await import('../app/(app)/admin/setup/[entity]/SetupDrawer')
const { PAYROLL_COMPENSATION_PACKAGES_ENTITY } = await import('../lib/setup/payroll-compensation-packages')
const id = '10000000-0000-4000-8000-000000000003'
const tick = () => new Promise(resolve => setTimeout(resolve, 40))
function button(name: string) { const found = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === name); assert.ok(found, name); return found }

async function edit(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  await act(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}

test('a native aggregate drawer retains its dialog, refusal and revision through save and retry', async t => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const prior = globalThis.fetch, requests: { url: string; body: Record<string, unknown> }[] = []
  const pending: ((response: Response) => void)[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Promise<Response>(resolve => pending.push(resolve)) }) as typeof fetch
  t.after(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = prior })
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><MoneyProvider currency="CAD"><SetupDrawer entity={PAYROLL_COMPENSATION_PACKAGES_ENTITY} row={{ id, code: 'POLICY', name: 'Employer policy', subsidiary_id: '10000000-0000-4000-8000-000000000004', country: 'CA', currency: 'CAD', description: null, reason: 'Earlier reason', revision: 7 }} members={[]} refOptions={{ subsidiaries: [{ value: '10000000-0000-4000-8000-000000000004', label: 'Employer' }], 'compensation-currencies': [{ value: 'CAD', label: 'CAD' }] }} closeHref="/admin/setup/payroll?tab=compensation-packages" /></MoneyProvider></NextIntlClientProvider>); await tick() })
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog)
  assert.equal(document.body.style.overflow, 'hidden')
  await act(() => button('Edit').click())
  const textareas = [...document.querySelectorAll('textarea')]
  assert.equal(textareas.at(-1)?.value, '', 'a new change must require a deliberate reason')
  await edit(textareas.at(-1)!, 'Rename employer package')
  const name = [...document.querySelectorAll('input')].find(input => input.value === 'Employer policy')!; assert.ok(name)
  await edit(name, 'Updated package')
  name.focus()
  await act(async () => { button('Save').click(); await tick() })
  assert.equal(requests.length, 1, dialog.textContent ?? '')
  assert.equal(requests[0]!.url, `/api/payroll/compensation-packages/${id}`)
  assert.deepEqual(requests[0]!.body, { name: 'Updated package', description: null, retire: false, reason: 'Rename employer package', expectedRevision: 7 })
  await act(async () => { pending.shift()!(Response.json({ error: 'Compensation revision changed — reload the record before saving.' }, { status: 422 })); await tick() })
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.match(dialog.textContent ?? '', /revision changed.*reload/)
  assert.equal(document.activeElement, name, 'a refused save retains focus in the existing form')
  assert.equal(document.body.style.overflow, 'hidden')
  await act(async () => { button('Save').click(); await tick() })
  assert.equal(requests.length, 2)
  assert.equal(document.activeElement, name)
  assert.equal(document.body.style.overflow, 'hidden')
  await act(async () => { pending.shift()!(Response.json({ id, revision: 8 })); await tick() })
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
})
