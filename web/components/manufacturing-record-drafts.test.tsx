import assert from 'node:assert/strict';
import test from 'node:test';
import {stubModules} from '../testing/stub-modules.ts';
import {bootJsdomEnvironment,setJsdomInput} from '../testing/jsdom-env.ts';

await bootJsdomEnvironment({url:'http://localhost/manufacturing/routings',event:'jsdom',matchMediaMatches:false});
const navigation:string[]=[];
Object.assign(globalThis,{__manufacturingRecordRouter:{push(href:string){navigation.push(href);},replace(href:string){navigation.push(href);},refresh(){}}});
stubModules({navigation:{source:'export function useRouter(){return globalThis.__manufacturingRecordRouter}'},intl:false,authz:false,features:false,
  extra:{sonner:'export const toast={success(){},error(){}};'}});
const React=await import('react');Object.assign(globalThis,{React});
const {act}=React,{createRoot}=await import('react-dom/client');
const {NextIntlClientProvider}=await import('next-intl');
const messages=(await import('../messages/en')).default;
const {MoneyProvider}=await import('./money-provider.tsx');
const {BusinessDateProvider}=await import('./business-date-provider.tsx');
const {ConfirmRoot}=await import('../lib/confirm.tsx');
const {ManufacturingRecordHost}=await import('../app/(app)/manufacturing/RecordHost.tsx');
const first='019f0000-0000-4000-8000-000000000031',second='019f0000-0000-4000-8000-000000000032',created='019f0000-0000-4000-8000-000000000033';
const item='019f0000-0000-4000-8000-000000000034',entity='019f0000-0000-4000-8000-000000000035';
const options={items:[{value:item,label:'Output'}],subsidiaries:[{value:entity,label:'Company'}],locations:[],centers:[],routings:[],departments:[],calendars:[],vendors:[],reasons:[]};
const detail=(id:string)=>({record:{id,status:'active',name:id===first?'First approved route':'Second approved route',code:id===first?'ROUTE-A':'ROUTE-B',version:1,producedItemId:item},sections:{operations:[],versions:[]}});
const settle=()=>new Promise(resolve=>setTimeout(resolve,200));
const button=(label:string,within:ParentNode=document)=>{
  const found=[...within.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent?.trim()===label);
  assert.ok(found,'Expected action '+label);return found;
};
async function mount(t:{after:(fn:()=>Promise<void>)=>void}) {
  const priorFetch=globalThis.fetch;
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  navigation.length=0;
  t.after(async()=>{await act(()=>root.unmount());host.remove();globalThis.fetch=priorFetch;});
  const render=async(id:string)=>act(async()=>{
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="CAD"><BusinessDateProvider today="2026-10-10"><ManufacturingRecordHost view="routings" recordId={id} closeHref="/manufacturing/routings" options={options} canManage canPost canBuy={false} canReadJournal={false} canRollup/><ConfirmRoot/></BusinessDateProvider></MoneyProvider></NextIntlClientProvider>);
    await settle();
  });
  return {render};
}

test('cost-roll-up peer draft survives a refused tab change and is discarded only after confirmation',async t=>{
  const {render}=await mount(t);
  globalThis.fetch=(async()=>Response.json(detail(first))) as typeof fetch;
  await render(first);
  await act(async()=>{button(messages.manufacturing.tabs.standard).click();await settle();});
  const input=document.querySelector<HTMLInputElement>('input[inputmode="decimal"]');assert.ok(input);
  await act(()=>setJsdomInput(input,'12'));
  await act(async()=>{button(messages.manufacturing.tabs.summary).click();await settle();});
  const confirmation=[...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(node=>node.getAttribute('aria-labelledby')==='confirm-title');assert.ok(confirmation);
  await act(async()=>{button(messages.common.confirm.cancel,confirmation).click();await settle();});
  assert.equal(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value,'12');
  assert.equal(document.querySelectorAll('[role="tabpanel"]').length,1);
  await act(async()=>{button(messages.manufacturing.tabs.summary).click();await settle();});
  const accepted=document.querySelector<HTMLElement>('[aria-labelledby="confirm-title"]');assert.ok(accepted);
  await act(async()=>{button(messages.common.confirm.confirm,accepted).click();await settle();});
  assert.equal(document.querySelector('input[inputmode="decimal"]'),null);
  await act(async()=>{button(messages.manufacturing.tabs.standard).click();await settle();});
  assert.equal(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value,'1');
});

test('a detail body finishing after selection cannot replace the new route or its drawer shell',async t=>{
  const {render}=await mount(t);let finish!:(value:unknown)=>void;
  globalThis.fetch=(async(url:unknown)=>String(url).endsWith(first)?{ok:true,json:()=>new Promise(resolve=>{finish=resolve;})} as Response:Response.json(detail(second))) as typeof fetch;
  await render(first);await render(second);
  const shell=document.querySelector('[role="dialog"]');assert.ok(shell);
  await act(async()=>{finish(detail(first));await settle();});
  assert.match(document.body.textContent??'',/Second approved route/);
  assert.equal(document.querySelector('[role="dialog"]'),shell);
  assert.equal(document.querySelectorAll('[role="dialog"]').length,1);
});

test('a proposal finishing after its peer tab was discarded cannot clear a newly entered roll-up draft',async t=>{
  const {render}=await mount(t);let finish!:(response:Response)=>void;
  const preview={currency:'CAD',jointOutputCosts:[],material:'1.0000',labor:'1.0000',overhead:'0.0000',byproductCredit:'0.0000',standardCost:'2.0000',digest:'retained-preview'};
  globalThis.fetch=((url:unknown,init?:RequestInit)=>{
    if(String(url)==='/api/manufacturing/standard-rollup') {
      const body=JSON.parse(String(init?.body));
      return body.action==='preview'?Promise.resolve(Response.json(preview)):new Promise<Response>(resolve=>{finish=resolve;});
    }
    return Promise.resolve(Response.json(detail(first)));
  }) as typeof fetch;
  await render(first);
  await act(async()=>{button(messages.manufacturing.tabs.standard).click();await settle();});
  await act(async()=>{button(messages.manufacturing.rollup.preview).click();await settle();});
  const reason=document.querySelector<HTMLTextAreaElement>('textarea');assert.ok(reason);
  await act(()=>{
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(reason,'Update the effective standard');
    reason.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  await act(async()=>{button(messages.manufacturing.rollup.propose).click();await settle();});
  await act(async()=>{button(messages.manufacturing.tabs.summary).click();await settle();});
  const discard=document.querySelector<HTMLElement>('[aria-labelledby="confirm-title"]');assert.ok(discard);
  await act(async()=>{button(messages.common.confirm.confirm,discard).click();await settle();});
  await act(async()=>{button(messages.manufacturing.tabs.standard).click();await settle();});
  const quantity=document.querySelector<HTMLInputElement>('input[inputmode="decimal"]');assert.ok(quantity);
  await act(()=>setJsdomInput(quantity,'13'));
  await act(async()=>{finish(Response.json({changeId:created,preview}));await settle();});
  assert.equal(document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value,'13');
  await act(async()=>{button(messages.manufacturing.tabs.summary).click();await settle();});
  const confirmation=document.querySelector<HTMLElement>('[aria-labelledby="confirm-title"]');assert.ok(confirmation,'the new peer draft remains dirty after the previous proposal returns');
  await act(async()=>{button(messages.common.confirm.cancel,confirmation).click();await settle();});
});

test('a late created routing version cannot redirect selection or clear the new route command',async t=>{
  const {render}=await mount(t);let finish!:(response:Response)=>void;const posts:string[]=[];
  globalThis.fetch=((url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){posts.push(String(url));return new Promise<Response>(resolve=>{finish=resolve;});}
    return Promise.resolve(Response.json(detail(String(url).endsWith(first)?first:second)));
  }) as typeof fetch;
  const openVersion=async()=>act(async()=>{
    button(messages.manufacturing.journey.actions).click();await settle();
    button(messages.manufacturing.actions.newVersion).click();await settle();
  });
  await render(first);await openVersion();
  await act(async()=>{const form=document.querySelector('form');assert.ok(form);form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();});
  assert.deepEqual(posts,['/api/manufacturing/routings/'+first+'/versions']);
  await render(second);await openVersion();
  const currentCommand=document.querySelector('form');assert.ok(currentCommand);
  await act(async()=>{finish(Response.json({id:created}));await settle();});
  assert.match(document.body.textContent??'',/Second approved route/);
  assert.equal(document.querySelector('form'),currentCommand,'the prior save cannot clear the new record’s command draft');
  assert.deepEqual(navigation,[]);
});
