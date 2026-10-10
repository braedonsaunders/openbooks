import assert from 'node:assert/strict';
import test from 'node:test';
import { stubModules } from '../testing/stub-modules.ts';
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts';

await bootJsdomEnvironment({url:'http://localhost/manufacturing/quality',event:'jsdom'});
const navigation:string[]=[];
Object.assign(globalThis,{__manufacturingInspectionRouter:{push(href:string){navigation.push(href);},refresh(){}}});
stubModules({navigation:{source:'export function useRouter(){return globalThis.__manufacturingInspectionRouter}'},intl:false,authz:false,features:false});
const React=await import('react');
Object.assign(globalThis,{React});
const {act}=React;
const {createRoot}=await import('react-dom/client');
const {NextIntlClientProvider}=await import('next-intl');
const messages=(await import('../messages/en')).default;
const {InspectionHost}=await import('../app/(app)/manufacturing/quality/InspectionHost.tsx');
const first='019f0000-0000-4000-8000-000000000011',second='019f0000-0000-4000-8000-000000000012';
const itemId='019f0000-0000-4000-8000-000000000013';
function detail(id:string) {
  return {
    id,itemId,itemName:id===first?'First inspected output':'Second inspected output',tracking:'none',
    planSnapshot:{id:'019f0000-0000-4000-8000-000000000014',name:'Operation acceptance',point:'operation',operationSequence:10,measures:[]},
    quantity:'1.0000',status:'pending',disposition:null,measurements:{},reason:null,
    operationId:'019f0000-0000-4000-8000-000000000015',workOrderId:'019f0000-0000-4000-8000-000000000016',
    workOrderNumber:'PROD-001',operationName:'Inspect',lotId:null,serialId:null,lotNumber:null,serialNumber:null,
    receiptMovementId:null,sourceActive:true,reworkOperations:[],remainingInspectionQuantity:'1.0000',
    canFollowup:false,reworkResolved:false,reworkLoss:false,dispositionResult:null,
  };
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
for(const outcome of ['success','refusal'] as const) test(`inspection navigation clears the previous request lock after a late ${outcome}`,async t=>{
  const priorFetch=globalThis.fetch,posts:string[]=[],reads:string[]=[];
  let finish!:(response:Response)=>void;
  navigation.length=0;
  globalThis.fetch=((url:unknown,options?:RequestInit)=>{
    const href=String(url);
    if(options?.method==='POST') {
      posts.push(href);
      if(href.endsWith(first))return new Promise<Response>(resolve=>{finish=resolve;});
      return Promise.resolve(Response.json({...detail(second),status:'pass'}));
    }
    if(href.includes('/tracking?'))return Promise.resolve(Response.json({tracking:'none',lots:[],serials:[]}));
    reads.push(href);
    if(href.endsWith(first))return Promise.resolve(Response.json(detail(first)));
    if(href.endsWith(second))return Promise.resolve(Response.json(detail(second)));
    throw new Error('Unexpected inspection request '+href);
  }) as typeof fetch;
  const host=document.createElement('div');document.body.append(host);
  const root=createRoot(host);
  t.after(async()=>{await act(()=>root.unmount());host.remove();globalThis.fetch=priorFetch;});
  const render=async(recordId:string)=>act(async()=>{
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><InspectionHost recordId={recordId} closeHref="/manufacturing/quality" canInspect canPost scrapReasons={[]}/></NextIntlClientProvider>);
    await settle();
  });
  const submit=()=>{
    const form=document.querySelector('form');assert.ok(form);
    form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  };
  await render(first);
  await act(async()=>{submit();await settle();});
  assert.deepEqual(posts,['/api/manufacturing/inspections/'+first]);
  assert.equal(document.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled,true);
  await render(second);
  assert.match(document.body.textContent??'',/Second inspected output/);
  assert.equal(document.querySelectorAll('[role="dialog"]').length,1);
  const secondReads=reads.filter(href=>href.endsWith(second)).length;
  await act(async()=>{
    finish(outcome==='success'?Response.json({...detail(first),status:'pass'}):Response.json({error:'First inspection authority was revoked'},{status:404}));
    await settle();
  });
  assert.match(document.body.textContent??'',/Second inspected output/);
  assert.equal(document.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled,false,'the newly selected inspection must become actionable when the old request finishes');
  assert.doesNotMatch(document.body.textContent??'',/First inspection authority was revoked/);
  assert.equal(reads.filter(href=>href.endsWith(second)).length,secondReads,'an old save must not reload or overwrite the new inspection');
  assert.deepEqual(navigation,[]);
  await act(async()=>{submit();await settle();});
  assert.deepEqual(posts,['/api/manufacturing/inspections/'+first,'/api/manufacturing/inspections/'+second]);
});
