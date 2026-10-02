import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

const { bootJsdomEnvironment, setJsdomInput, clickJsdomElement } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost/hrm/processes/templates?template=tpl-1', matchMediaMatches: false, html: '<!doctype html><html><body><div id="root"></div></body></html>' })

const confirmCalls: unknown[] = []
const toastErrors: string[] = []
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../../testing/stub-modules')
stubModules({ navigation: true })
registerHooks({
  resolve(specifier, context, next) {
    const source = specifier === 'sonner'
      ? 'export const toast = { success(){}, error(msg){ globalThis.__templateToastErrors.push(msg) } }'
      : specifier.endsWith('/lib/confirm')
        ? 'export async function confirmDialog(options){ globalThis.__templateConfirmCalls.push(options); return true }'
        : null
    if (source) return { shortCircuit: true, url: 'data:text/javascript,' + source }
    return next(specifier, context)
  },
})
const { NextIntlClientProvider } = await import('next-intl')
const { ProcessTemplateDrawer } = await import('./ProcessTemplateDrawer')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })
Object.assign(globalThis, { __templateConfirmCalls: confirmCalls, __templateToastErrors: toastErrors })

const {default:messages}=await import('../../../../../messages/en')

const template = {
  id: '10000000-0000-4000-8000-000000000010', revision:1,publishedVersion:1,isActive:true,
  document:{name:'Onboarding',kind:'onboarding' as const,appliesTo:{employerSubsidiaryId:null,departmentId:null},steps:[{
    id:'10000000-0000-4000-8000-000000000011',title:'Collect documents',description:null,ownerKind:'manager' as const,ownerPartyId:null,dueOffsetDays:3,required:true,evidenceKind:'none' as const,
    design:{section:'Preparation',dependencies:[],condition:null,form:null,approval:false,reminderDays:null,resources:[]},
  }]},
}

type Mount = Awaited<ReturnType<typeof mount>>

async function mount(creating=false,respond?:(body:Record<string,unknown>)=>Promise<Response>) {
  const previousFetch = globalThis.fetch
  // The native confirm must never fire: deletes go through the house dialog.
  let nativeConfirmCalls = 0
  const winRec = window as unknown as Record<string, unknown>
  const prevConfirm = winRec.confirm
  winRec.confirm = () => {
    nativeConfirmCalls += 1
    return false
  }
  const doc = document
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const root = createRoot(doc.getElementById('root')!)
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null })
    const body=init?.body ? JSON.parse(init.body):{};if(respond)return respond(body);return Response.json({...template,revision:body.revision+1,document:body.document ?? template.document})
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <ProcessTemplateDrawer
          template={creating?null:template}
          creating={creating}
          closeHref="/hrm/processes/templates"
          subsidiaries={[]}
          departments={[]}
          employees={[]}
        />
      </NextIntlClientProvider>,
    )
  })
  return {
    document: doc as unknown as Document,
    calls,
    get nativeConfirmCalls() {
      return nativeConfirmCalls
    },
    setInput: setJsdomInput,
    click: clickJsdomElement,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      winRec.confirm = prevConfirm
      globalThis.fetch = previousFetch
    },
  }
}

async function flushAsync(): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const button=(m:Mount,label:string)=>{const result=[...m.document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(result,`Button ${label} must render`);return result}
test('new templates offer six starters and accept steps before the first save',async()=>{
 const m=await mount(true);const {act}=await import('react');try{
  assert.equal(m.document.querySelectorAll('[role="radio"]').length,6)
  await act(async()=>m.click([...m.document.querySelectorAll('[role="radio"]')].find(b=>b.textContent?.includes('Start from scratch'))!))
  await act(async()=>m.setInput(m.document.getElementById('checklist-name') as HTMLInputElement,'Custom welcome'))
  await act(async()=>m.click(button(m,'Add step')))
  await act(async()=>m.setInput(m.document.getElementById('step-title') as HTMLInputElement,'Arrange introductions'))
  assert.equal(m.calls.length,0,'local step editing needs no record creation first')
  const shell=m.document.querySelector('[role="dialog"]')
  await act(async()=>m.click(button(m,'Save draft')));await flushAsync()
  assert.equal(m.calls[0]?.url,'/api/hrm/process-templates/designer');const doc=m.calls[0]?.body?.document as typeof template.document;assert.equal(doc.name,'Custom welcome');assert.equal(doc.steps[0]?.title,'Arrange introductions')
  assert.equal(m.document.querySelector('[role="dialog"]'),shell,'the drawer shell survives the first save')
 }finally{await m.unmount()}
})
test('deleting a step confirms once and saves the whole draft without a destructive step request',async()=>{
 confirmCalls.length=0;const m=await mount();const {act}=await import('react');try{
  await act(async()=>m.click(m.document.querySelector('button[aria-label="Delete"]')!));await flushAsync()
  assert.equal(m.nativeConfirmCalls,0);assert.equal(confirmCalls.length,1)
  assert.ok(!m.document.body.textContent?.includes('Collect documents'))
  await act(async()=>m.click(button(m,'Save draft')));await flushAsync()
  assert.equal(m.calls.some(c=>c.method==='DELETE'),false)
  assert.equal((m.calls[0]?.body?.document as typeof template.document).steps.length,0)
 }finally{await m.unmount()}
})
test('invalid due days name the valid range and never reach the save endpoint',async()=>{
 const m=await mount();const {act}=await import('react');try{
  await act(async()=>m.setInput(m.document.getElementById('step-days') as HTMLInputElement,'99999'))
  await act(async()=>m.click(button(m,'Save draft')));await flushAsync()
  assert.equal(m.calls.length,0)
  assert.match(m.document.querySelector('[role="alert"]')?.textContent ?? '',/whole number of days between -3650 and 3650/)
 }finally{await m.unmount()}
})

test('a refused save retains local edits and a saved-draft reload keeps the same dialog',async()=>{
 let mode='refuse';const m=await mount(false,async body=>mode==='refuse'?Response.json({error:'Another editor saved this draft — reload the latest revision before applying your changes.'},{status:422}):Response.json({...template,revision:2,document:{...template.document,name:'Latest colleague welcome'}}));
 const {act}=await import('react');try{
  const shell=m.document.querySelector('[role="dialog"]');await act(async()=>m.setInput(m.document.getElementById('step-title') as HTMLInputElement,'My local task'))
  await act(async()=>m.click(button(m,'Save draft')));await flushAsync()
  assert.match(m.document.querySelector('[role="alert"]')?.textContent ?? '',/Another editor saved this draft/)
  assert.equal((m.document.getElementById('step-title') as HTMLInputElement).value,'My local task')
  mode='load';await act(async()=>m.click(button(m,'Reload saved draft')));await flushAsync()
  assert.equal(m.document.querySelector('[role="dialog"]'),shell)
  assert.equal((m.document.getElementById('step-title') as HTMLInputElement).value,'Collect documents')
  assert.equal(m.calls.at(-1)?.body?.action,'load')
 }finally{await m.unmount()}
})
