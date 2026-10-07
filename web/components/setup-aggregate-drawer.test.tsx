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

test('an in-flight nested decision blocks the native setup shell close and parent-tab navigation', async t => {
  const { useDirtyUrlDrawer } = await import('./dirty-url-drawer')
  const routes: string[] = []
  Object.assign(globalThis, { __aggregateRouter: { push(url: string) { routes.push(url) }, replace(url: string) { routes.push(url) }, refresh() {}, prefetch() {} } })
  window.history.replaceState(null, '', '/admin/setup/payroll?tab=compensation-packages&package='+id+'&setupTab=review')
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  function Decision({busy}:{busy:boolean}) { useDirtyUrlDrawer(false,busy);return <p>Pending decision</p> }
  const render=(busy:boolean)=><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><MoneyProvider currency="CAD"><SetupDrawer entity={{...PAYROLL_COMPENSATION_PACKAGES_ENTITY,readOnly:true}} row={{id,code:'POLICY',name:'Employer policy',subsidiary_id:'10000000-0000-4000-8000-000000000004',country:'CA',currency:'CAD',revision:7}} members={[]} refOptions={{}} closeHref="/admin/setup/payroll?tab=compensation-packages" nestedTabs={[{key:'review',label:'Review',content:<Decision busy={busy}/>}]}/></MoneyProvider></NextIntlClientProvider>
  t.after(async()=>{await act(()=>root.unmount());host.remove()})
  await act(async()=>{root.render(render(true));await tick()})
  const dialog=document.querySelector('[role=dialog]');assert.ok(dialog)
  assert.match(dialog.textContent??'',/Pending decision/)
  const details=[...dialog.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Details');assert.ok(details)
  const close=dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement;assert.ok(close)
  await act(async()=>{details.click();close.click();await tick()})
  assert.deepEqual(routes,[],'Neither tab navigation nor shell close may abandon an in-flight decision')
  assert.equal(document.querySelector('[role=dialog]'),dialog)
  await act(async()=>{root.render(render(false));await tick()})
  await act(async()=>{details.click();await tick()})
  assert.equal(routes.length,1)
  assert.ok(!(routes as string[])[0]!.includes('setupTab=review'))
})


test('transaction configuration tabs replace the active concept inside one native drawer', async t => {
  const {BENEFIT_TRANSACTION_POLICY_ENTITY}=await import('../lib/setup/benefit-transaction-policy');
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  t.after(async()=>{await act(()=>root.unmount());host.remove()});
  await act(async()=>{root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><MoneyProvider currency="CAD"><SetupDrawer entity={BENEFIT_TRANSACTION_POLICY_ENTITY} row={{id,revision:7,document_kind:'sales_order',date_basis:'document_date',grouping_segment_id:null,positions:[{key:'lead',name:'Lead',weight:'2.0000'}],responsibilities:[],limits:[],reason:''}} members={[]} refOptions={{}} closeHref="/hrm/benefits?view=programs" /></MoneyProvider></NextIntlClientProvider>);await tick()});
  const dialog=document.querySelector('[role=dialog]');assert.ok(dialog);
  const sections=messages.admin.setup.transactionBenefits;
  assert.ok([...dialog.querySelectorAll('label')].some(label=>label.textContent?.includes(sections.fields.documentKind)));
  assert.equal(button(sections.positions).disabled,false,'Existing configuration sections are views, not locked creation steps');
  await act(()=>button(sections.positions).click());
  assert.equal(document.querySelector('[role=dialog]'),dialog);assert.equal(document.querySelectorAll('[role=dialog]').length,1);
  assert.ok(![...dialog.querySelectorAll('label')].some(label=>label.textContent?.includes(sections.fields.documentKind)));
  assert.ok([...dialog.querySelectorAll('label')].some(label=>label.textContent?.includes(sections.fields.weight)));
  await act(()=>button(sections.responsibilities).click());
  assert.ok(![...dialog.querySelectorAll('label')].some(label=>label.textContent?.includes(sections.fields.weight)));
  assert.equal(document.querySelector('[role=dialog]'),dialog);
  await act(()=>button(sections.source).click());
  assert.ok([...dialog.querySelectorAll('label')].some(label=>label.textContent?.includes(sections.fields.documentKind)));
  assert.ok(![...dialog.querySelectorAll('label')].some(label=>label.textContent?.includes(sections.fields.weight)));
  assert.equal(document.querySelector('[role=dialog]'),dialog);
});
