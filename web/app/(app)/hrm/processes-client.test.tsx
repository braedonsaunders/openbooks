import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost/hrm/processes', scrollIntoView: false, resizeObserver: false })

Object.assign(globalThis, { React })
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: true, extra: { 'next-intl': 'export const useTranslations=()=>key=>key;export const useLocale=()=>"en"' } })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === '@openbooks/ui') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export * from ${JSON.stringify(new URL('../../../../packages/ui/src/index.ts',import.meta.url).href)};const React=globalThis.React;export const SearchSelect=({options,onSearchChange,id})=>React.createElement('div',null,React.createElement('input',{id,onInput:e=>onSearchChange(e.target.value)}),...options.map(o=>React.createElement('option',{key:o.value,value:o.value},o.label)))`,
      }
    }
    return next(specifier, context)
  },
})

const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { ProcessChecklistBody } = await import('./processes-client')

const detail = {
  id: 'proc-1',
  kind: 'onboarding',
  effectiveDate: '2026-09-01',
  status: 'open',
  employmentId: 'employment-1',
  workerPartyId: 'worker-1',
  workerName: 'Worker',
  openedByChangeId: null,
  progress: { total: 1, required: 1, doneRequired: 0, allRequiredDone: false },
  steps: [
    {
      id: 'step-1',
      position: 0,
      title: 'Attach evidence',
      description: null,
      ownerKind: 'manager',
      ownerPartyId: null,
      dueOn: '2026-09-15',
      required: true,
      evidenceKind: 'attachment',
      status: 'pending',
      overdue: false,
    },
  ],
} as never

test('file suggestions are query-bound and a failed new search reports an error', async (t) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('q=first')) return Response.json({ files: [{ id: 'old-file', name: 'Old result' }] })
    return new Response('unavailable', { status: 503 })
  }
  t.after(() => { globalThis.fetch = realFetch })

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<ProcessChecklistBody detail={detail} />))
  const input = host.querySelector('input')!

  await act(async () => {
    input.value = 'first'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
  assert.ok(host.textContent?.includes('Old result'))

  await act(async () => {
    input.value = 'second'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.ok(!host.textContent?.includes('Old result'), 'results for the previous query must immediately become unavailable')

  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
  assert.ok(!host.textContent?.includes('Old result'), 'a refused query must not restore old suggestions')
  assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes('processes.fileSearchFailed'))
  await act(async () => root.unmount())
  host.remove()
})

test('approved acknowledgement evidence remains checked and can complete without re-editing reviewed input',async t=>{
 const {emptyStepDesign}=await import('@openbooks/forms-core')
 const calls:{url:string;body:unknown}[]=[];const realFetch=globalThis.fetch
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),body:JSON.parse(String(init?.body))});return Response.json({ok:true})};t.after(()=>{globalThis.fetch=realFetch})
 const approved:import('@openbooks/engine/hrm/processes').ProcessDetail={id:'proc-2',kind:'onboarding',effectiveDate:'2026-10-01',status:'open',employmentId:'employment-2',workerPartyId:'worker-2',workerName:'Jamie',openedByChangeId:null,canManage:false,progress:{total:1,required:1,doneRequired:0,allRequiredDone:false},steps:[{id:'step-2',position:0,title:'Review handbook',description:'Confirm the reviewed policy.',ownerKind:'employee',ownerPartyId:null,dueOn:'2026-10-01',required:true,evidenceKind:'acknowledgement',status:'pending',overdue:false,doneBy:null,skipReason:null,attachmentId:null,approvalStatus:'approved',canComplete:true,canSkip:false,design:{...emptyStepDesign(),approval:true}}]}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try {
  await act(async()=>root.render(<ProcessChecklistBody detail={approved}/>))
  const acknowledgement=host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;assert.equal(acknowledgement.checked,true);assert.equal(acknowledgement.disabled,true)
  const complete=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='processes.completeStep')!;assert.equal(complete.disabled,false)
  await act(async()=>complete.click());assert.deepEqual(calls,[{url:'/api/hrm/processes/steps/step-2/complete',body:{acknowledged:true}}])
 } finally {await act(async()=>root.unmount());host.remove()}
})
