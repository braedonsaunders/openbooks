'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input, Select, UrlDrawer, SearchSelect } from '@openbooks/ui';
import { DrawerTabStrip } from '@/components/drawer-tab-strip';
import { readApiErrorMessage } from '@/lib/api-error';
import { useMoney } from '@/components/money-provider';
import type { RebateAgreement, RebateClaim } from '@openbooks/engine/revenue/rebates';
import { cmp } from '@openbooks/engine/money/money';
import { DateField } from '@/components/date-field'

type Data={agreement:RebateAgreement;claim:RebateClaim|null;parties:{id:string;name:string}[];banks:{id:string;name:string}[];canPost:boolean;today:string;baseCurrency:string;sources:{lineId:string;documentId:string;label:string}[]};
export function RebateDrawer({data,closeHref}:{data:Data;closeHref:string}) {
 const router=useRouter(),{money}=useMoney(data.agreement.currency),a=data.agreement,c=data.claim;
 const [date,setDate]=useState(data.today),[reason,setReason]=useState(''),[partyId,setPartyId]=useState(a.party_id??data.parties[0]?.id??''),[bankId,setBankId]=useState(''),[fxRate,setFxRate]=useState(a.currency===data.baseCurrency?'1':''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[tab,setTab]=useState('terms'),[method,setMethod]=useState('credit');
 const [lineId,setLineId]=useState(''),[cost,setCost]=useState(''),[resale,setResale]=useState(''),[evidence,setEvidence]=useState(''),[documentId,setDocumentId]=useState('');
 async function command(body:Record<string,unknown>) {
  setBusy(true);setError('');
  try {const response=await fetch('/api/rebates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok){setError(await readApiErrorMessage(response,'Rebate action could not be completed'));return;}
   const result=await response.json(); if(result.documentId){const href=result.kind==='customer_credit'?`/ar/credits?doc=${result.documentId}`:result.kind==='customer_invoice'?`/ar/invoices?doc=${result.documentId}`:result.kind==='vendor_credit'?`/ap/credits?doc=${result.documentId}`:`/ap/bills?doc=${result.documentId}`;router.push(href);}else if(body.action==='claim'&&result.id){router.push(`/rebates?view=claims&record=${result.id}`);}router.refresh();
  } catch {setError('Rebate action could not be completed');}finally{setBusy(false);}
 }
 const reasonInput=<label className="block text-sm">Review reason<Input value={reason} onChange={e=>setReason(e.target.value)}/></label>;
 const dateInput=<label className="block text-sm">Posting or cutoff date<DateField value={date} onChange={value=>setDate(value)}/></label>;
 return <UrlDrawer open closeHref={closeHref} size="xl" title={c?'Rebate claim':a.name} description={`${a.code} · ${a.side} · ${c?.status??a.status}`}>
  <div className="space-y-4 p-1">
   {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
   {c?<>
    <p className="text-lg tabular-nums">{money(c.amount)} {a.currency}</p><p className="text-sm">Earned through {c.cutoff_on}. Settlement clears the recorded accrual.</p>
    {data.canPost&&c.status==='draft'?<>{reasonInput}<Button disabled={busy||reason.trim().length<8} onClick={()=>command({action:'approveClaim',claimId:c.id,reason})}>Approve claim</Button></>:null}
    {data.canPost&&c.status==='approved'?<>
     <label className="block text-sm">Settlement method<Select value={method} onChange={e=>setMethod(e.target.value)}><option value="credit">Native credit or recovery document</option><option value="payment">Bank payment or receipt</option></Select></label>{dateInput}
     {method==='credit'?<Button disabled={busy||!date} onClick={()=>command({action:'prepareCredit',claimId:c.id,documentDate:date})}>Prepare {cmp(c.amount,'0')>0?'credit':'recovery'} document</Button>:<>
      <label className="block text-sm">Bank account<SearchSelect value={bankId} onChange={setBankId} options={data.banks.map(b=>({value:b.id,label:b.name}))}/></label>
      <label className="block text-sm">Settlement FX rate ({a.currency} to {data.baseCurrency})<Input value={fxRate} onChange={e=>setFxRate(e.target.value)}/></label>{reasonInput}
      <Button disabled={busy||!date||!bankId||!fxRate||reason.trim().length<8} onClick={()=>command({action:'pay',claimId:c.id,postingDate:date,bankAccountId:bankId,fxRate,reason})}>Record bank settlement</Button>
     </>}
    </>:null}
    {data.canPost&&['draft','approved'].includes(c.status)?<Button variant="outline" disabled={busy||reason.trim().length<8} onClick={()=>command({action:'cancelClaim',claimId:c.id,reason})}>Cancel claim</Button>:null}
    {c.settlement_document_id?<Link className="underline" href={`${a.side==='customer'?cmp(c.amount,'0')>0?'/ar/credits':'/ar/invoices':cmp(c.amount,'0')>0?'/ap/credits':'/ap/bills'}?doc=${c.settlement_document_id}`}>Open settlement document</Link>:null}
    {data.canPost&&c.status==='settled'&&!c.settlement_document_id?<>{dateInput}{reasonInput}<Button variant="outline" disabled={busy||!date||reason.trim().length<8} onClick={()=>command({action:'reversePayment',claimId:c.id,postingDate:date,reason})}>Reverse bank settlement</Button></>:null}
   </>:<>
    <DrawerTabStrip tabs={[{key:'terms',label:'Terms'},{key:'claim',label:'Generate claim'},{key:'cost',label:'Cost evidence'}]} activeKey={tab} onSelect={setTab} ariaLabel="Agreement details"/>
    {tab==='terms'?<><p>Eligible {a.activity.replaceAll('_',' ')} from {a.effective_from} through {a.effective_to}; {a.currency}.</p><p>{a.method.replaceAll('_',' ')} · {a.stacking==='stack'?'Stack with eligible agreements':'Best deal per line'} · group {a.selection_group}.</p><Link className="underline" href={`/admin/setup/rebate-agreements?row=${a.id}`}>View agreement settings</Link>
     {data.canPost&&a.status==='draft'?<>{reasonInput}<Button disabled={busy||reason.trim().length<8} onClick={()=>command({action:'approveAgreement',agreementId:a.id,reason})}>Approve agreement</Button></>:null}</>:null}
    {tab==='claim'?<><label className="block text-sm">Customer or vendor<SearchSelect value={partyId} onChange={setPartyId} options={data.parties.map(p=>({value:p.id,label:p.name}))}/></label>{dateInput}{reasonInput}
     <Button disabled={!data.canPost||busy||a.status!=='approved'||!partyId||reason.trim().length<8} onClick={()=>command({action:'claim',agreementId:a.id,partyId,cutoffOn:date,reason})}>Generate earned claim</Button></>:null}
    {tab==='cost'?<><p className="text-sm">Stock costs use posted inventory evidence. For other items, record documented cost before posting or reassessing the source transaction.</p>
     <label className="block text-sm">Source document line<SearchSelect value={lineId} onChange={setLineId} options={data.sources.map(s=>({value:s.lineId,label:s.label}))}/></label><label className="block text-sm">Cost in {a.currency}<Input value={cost} onChange={e=>setCost(e.target.value)}/></label><label className="block text-sm">Documented downstream resale amount (margin guarantees)<Input value={resale} onChange={e=>setResale(e.target.value)}/></label><label className="block text-sm">Cost evidence<Input value={evidence} onChange={e=>setEvidence(e.target.value)}/></label>
     <Button variant="outline" disabled={!data.canPost||busy||!lineId||!cost||evidence.trim().length<20} onClick={()=>command({action:'attestCost',documentLineId:lineId,costAmount:cost,resaleAmount:resale||null,currency:a.currency,evidence})}>Record cost evidence</Button>
     <label className="block text-sm">Posted source transaction<SearchSelect value={documentId} onChange={setDocumentId} options={[...new Map(data.sources.map(s=>[s.documentId,{value:s.documentId,label:s.label.split(' · ')[0]!}])).values()]}/></label>{dateInput}{reasonInput}<Button disabled={!data.canPost||busy||!documentId||reason.trim().length<8} onClick={()=>command({action:'reassess',documentId,postingDate:date,reason})}>Reassess earned rebates</Button>
    </>:null}
   </>}
  </div>
 </UrlDrawer>;
}
