import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { bootJsdomEnvironment, setJsdomInput } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'
await bootJsdomEnvironment({url:'http://localhost/hrm/processes?segment=overdue&sub=entity-one'})
Object.assign(globalThis,{React})
const pushes: string[] = []
;(globalThis as Record<symbol,unknown>)[Symbol.for('openbooks.process-create.router')] = pushes
stubModules({navigation:`export function useRouter(){return {push(href){globalThis[Symbol.for('openbooks.process-create.router')].push(href)},refresh(){}}}export function usePathname(){return '/hrm/processes'}export function useSearchParams(){return new URLSearchParams()}`})
const {createRoot} = await import('react-dom/client')
const {NextIntlClientProvider} = await import('next-intl')
const {default:messages} = await import('../../../../messages/en')
const {ProcessCreateDrawer} = await import('./ProcessCreateDrawer')
const employmentId = '00000000-0000-4000-8000-000000000031'
const templateId = '00000000-0000-4000-8000-000000000032'
const processId = '00000000-0000-4000-8000-000000000033'
const originalFetch = globalThis.fetch
const calls: {url:string;body?:Record<string,unknown>}[] = []
let kind: 'onboarding' | 'offboarding' | 'transfer' = 'offboarding'
let unavailable = false
let templateResponse: Promise<Response> | undefined
function reset() {
  pushes.length=0; calls.length=0; unavailable=false; templateResponse=undefined
  globalThis.fetch = (async (input,init) => {
    const url=String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string,unknown> : undefined
    calls.push({url,body})
    if (url.startsWith('/api/hrm/options')) return Response.json({options:unavailable?[]:[{employmentId,label:'Avery Worker · Main entity'}]})
    if (url.startsWith('/api/hrm/process-templates')) return templateResponse ?? Response.json({templates:[{id:templateId,name:'Employee transition',kind,stepCount:2}]})
    if (url==='/api/hrm/processes' && body) return Response.json({process:{id:processId}},{status:201})
    throw new Error('unexpected request: '+url)
  }) as typeof fetch
}
test.after(()=>{globalThis.fetch=originalFetch})
async function mount() {
  const host=document.createElement('div');document.body.append(host)
  const root=createRoot(host)
  await act(async()=>{root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><ProcessCreateDrawer create={{closeHref:'/hrm/processes?segment=overdue&sub=entity-one',effectiveDate:'2026-09-30',templatesHref:'/hrm/processes/templates?template=new'}}/></NextIntlClientProvider>);await new Promise(resolve=>setTimeout(resolve,30))})
  return {close:async()=>{await act(async()=>root.unmount());host.remove()}}
}
async function click(element: Element) {
  await act(async()=>{element.dispatchEvent(new MouseEvent('click',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,30))})
}
async function choose(id:string,label:string) {
  if(id==='process-template') {const card=[...document.querySelectorAll('[role=radio]')].find(option=>option.textContent?.includes(label));assert.ok(card,`missing template card: ${label}`);await click(card);return}
  await click(document.getElementById(id)!)
  const choice=[...document.querySelectorAll('[role=option]')].find(option=>option.textContent?.includes(label))
  assert.ok(choice,`missing choice: ${label}`)
  await click(choice)
}
function submit() { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.trim()==='Create')! }

for (const selectedKind of ['onboarding','offboarding','transfer'] as const) {
  test(`a ${selectedKind} template supplies the checklist kind without a second selection`,async()=>{
    reset();kind=selectedKind
    const screen=await mount()
    try {
      assert.ok(calls.filter(call=>call.url.startsWith('/api/hrm/options')).every(call=>new URL(call.url,'http://localhost').searchParams.get('active')==='true'))
      assert.equal(document.getElementById('process-kind'),null)
      await choose('process-employment','Avery Worker')
      assert.ok(calls.some(call=>call.url.startsWith('/api/hrm/process-templates')))
      assert.ok(calls.filter(call=>call.url.startsWith('/api/hrm/process-templates')).every(call=>!new URL(call.url,'http://localhost').searchParams.has('kind')))
      await choose('process-template','Employee transition')
      assert.equal((document.getElementById('process-kind') as HTMLInputElement).readOnly,true)
      assert.equal(submit().disabled,false)
      await click(submit())
      const body=calls.find(call=>call.body)?.body
      assert.deepEqual(body,{employmentId,kind:selectedKind,effectiveDate:'2026-09-30',templateId})
      assert.equal(new URL(pushes.at(-1)!,'http://localhost').searchParams.get('sub'),'entity-one')
      assert.equal(new URL(pushes.at(-1)!,'http://localhost').searchParams.get('process'),processId)
    } finally {await screen.close()}
  })
}

test('an employee removed from active options cannot submit a new checklist',async()=>{
  reset();const screen=await mount()
  try {
    unavailable=true
    await choose('process-employment','Avery Worker')
    assert.match(document.querySelector('[role=alert]')?.textContent??'',/Choose an active employee/)
    assert.equal(submit().disabled,true)
    assert.equal(calls.some(call=>call.body),false)
  } finally {await screen.close()}
})

test('a refused template lookup presents its remedy and keeps creation disabled',async()=>{
  reset();templateResponse=Promise.resolve(Response.json({error:'Record the employment event before choosing a template.'},{status:422}))
  const screen=await mount()
  try {
    await choose('process-employment','Avery Worker')
    assert.match(document.body.textContent??'',/Record the employment event before choosing a template/)
    assert.equal(submit().disabled,true)
  } finally {await screen.close()}
})

test('an earlier template response cannot replace the selection for a changed effective date',async()=>{
  reset();kind='offboarding'
  let finish!: (response:Response)=>void
  const earlier=new Promise<Response>(resolve=>{finish=resolve})
  const screen=await mount()
  try {
    templateResponse=earlier
    await choose('process-employment','Avery Worker')
    templateResponse=undefined
    const date=document.getElementById('process-effective') as HTMLInputElement
    await act(async()=>{
      setJsdomInput(date,'2026-10-01')
      date.dispatchEvent(new window.Event('change',{bubbles:true}))
      await new Promise(resolve=>setTimeout(resolve,30))
    })
    await choose('process-template','Employee transition')
    await act(async()=>{finish(Response.json({templates:[{id:'old-template',name:'Outdated choice',kind:'onboarding',stepCount:2}]}));await new Promise(resolve=>setTimeout(resolve,30))})
    assert.match(document.getElementById('process-template')!.textContent??'',/Employee transition/)
    assert.equal((document.getElementById('process-kind') as HTMLInputElement).value,'Offboarding')
    await click(submit())
    assert.equal(calls.find(call=>call.body)?.body?.effectiveDate,'2026-10-01')
    assert.equal(calls.find(call=>call.body)?.body?.kind,'offboarding')
  } finally {await screen.close()}
})
