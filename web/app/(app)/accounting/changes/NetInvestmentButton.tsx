'use client'
import { useId,useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button,Drawer,Input,Label,SearchSelect,Textarea } from '@openbooks/ui'
import { useBusinessToday } from '@/components/business-date-provider'
import { useDirtyClose } from '@/lib/use-dirty-close'
import { readApiErrorMessage } from '@/lib/api-error'
import type { loadNetInvestmentOptions } from '@openbooks/engine/consolidation'
type Setup=Awaited<ReturnType<typeof loadNetInvestmentOptions>>
/** Composes the existing accounting proposal drawer; Flows owns approval. */
export function NetInvestmentButton({interestId}:{interestId:string}) {
  const router=useRouter(),today=useBusinessToday(),common=useTranslations('common'),t=useTranslations('accounting.lifecycle.netInvestment'),prefix=useId()
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[setup,setSetup]=useState<Setup|null>(null),[error,setError]=useState<string|null>(null)
  const [values,setValues]=useState<Record<string,string>>({date:today}),[sources,setSources]=useState<string[]>([]),[qualified,setQualified]=useState(false),[nonTrade,setNonTrade]=useState(false)
  const [key,setKey]=useState(()=>crypto.randomUUID()),[initialKey,setInitialKey]=useState(key)
  const update=(field:string,value:string)=>{setValues(current=>({...current,[field]:value}));setKey(crypto.randomUUID());if(field==='pair' || field==='book')setSources([])}
  const close=()=>{setOpen(false);setValues({date:today});setSources([]);setQualified(false);setNonTrade(false);setError(null);const next=crypto.randomUUID();setKey(next);setInitialKey(next)}
  const guard=useDirtyClose({dirty:key!==initialKey,busy,onClose:close,message:common('feedback.unsavedChanges'),confirmLabel:common('confirm.discardChanges')})
  const url=`/api/consolidation/interests/${interestId}/net-investment`
  async function show(){setOpen(true);setBusy(true);setError(null);setSetup(null);try{
    const response=await fetch(url);if(!response.ok)throw new Error(await readApiErrorMessage(response,t('failed')))
    const next=await response.json() as Setup;setSetup(next);setValues({date:today,book:next.books.length===1 ? next.books[0]!.id : ''})
  }catch(caught){setError(caught instanceof Error ? caught.message : t('failed'))}finally{setBusy(false)}}
  async function save(){setBusy(true);setError(null);try{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pairId:values.pair,bookId:values.book,eliminationSubsidiaryId:values.elimination,ociAccountId:values.oci,
      profitLossAccountId:values.pnl,sourceLineIds:sources,notPlannedOrLikely:qualified,nonTrade,qualificationEvidence:values.evidence,effectiveOn:values.date,reason:values.reason,idempotencyKey:key})})
    if(!response.ok)throw new Error(await readApiErrorMessage(response,t('failed')))
    const result=await response.json() as {changeId:string};close();router.push(`/accounting/changes?change=${result.changeId}`);router.refresh()
  }catch(caught){setError(caught instanceof Error ? caught.message : t('failed'))}finally{setBusy(false)}}
  const picker=(field:string,label:string,options:{value:string;label:string}[]) => <div className="space-y-1"><Label>{label}</Label><SearchSelect ariaLabel={label} value={values[field] ?? ''} onChange={value=>update(field,value)} options={options} placeholder={t('choose')} disabled={busy}/></div>
  return <><Button variant="outline" onClick={()=>void show()}>{t('title')}</Button>{open ? <Drawer stacked open title={t('title')} onClose={guard.close} size="lg"><div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t('hint')}</p>
    {setup ? <>
      {picker('pair',t('pair'),setup.pairs.map(pair=>({value:pair.id,label:pair.label})))}
      {picker('book',t('book'),setup.books.map(book=>({value:book.id,label:book.name})))}
      {picker('elimination',t('elimination'),setup.eliminations.map(entity=>({value:entity.id,label:entity.name+' — '+entity.base_currency})))}
      {picker('oci',t('oci'),setup.accounts.filter(account=>account.type==='equity').map(account=>({value:account.id,label:account.number+' — '+account.name})))}
      {picker('pnl',t('pnl'),setup.accounts.filter(account=>account.type!=='equity').map(account=>({value:account.id,label:account.number+' — '+account.name})))}
      <div className="space-y-1"><Label htmlFor={prefix+'date'}>{t('date')}</Label><Input id={prefix+'date'} type="date" value={values.date ?? ''} disabled={busy} onChange={event=>update('date',event.target.value)}/></div>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('sources')}</legend>{setup.sources.filter(source=>source.pairId===values.pair && source.bookId===values.book && source.postingDate<=(values.date ?? '')).map(source=><label key={source.id} className="flex items-start gap-2 text-sm"><Input type="checkbox" checked={sources.includes(source.id)} disabled={busy} onChange={event=>{setSources(current=>event.target.checked ? [...current,source.id] : current.filter(id=>id!==source.id));setKey(crypto.randomUUID())}}/>{source.label}</label>)}<p className="text-sm text-muted-foreground">{t('sourceHint')}</p></fieldset>
      <label className="flex items-start gap-2 text-sm"><Input type="checkbox" checked={qualified} disabled={busy} onChange={event=>{setQualified(event.target.checked);setKey(crypto.randomUUID())}}/>{t('qualified')}</label>
      <label className="flex items-start gap-2 text-sm"><Input type="checkbox" checked={nonTrade} disabled={busy} onChange={event=>{setNonTrade(event.target.checked);setKey(crypto.randomUUID())}}/>{t('nonTrade')}</label>
      <div className="space-y-1"><Label htmlFor={prefix+'evidence'}>{t('evidence')}</Label><Textarea id={prefix+'evidence'} maxLength={10000} value={values.evidence ?? ''} disabled={busy} onChange={event=>update('evidence',event.target.value)}/></div>
      <div className="space-y-1"><Label htmlFor={prefix+'reason'}>{t('reason')}</Label><Textarea id={prefix+'reason'} maxLength={1000} value={values.reason ?? ''} disabled={busy} onChange={event=>update('reason',event.target.value)}/></div>
    </> : null}
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    <div className="flex gap-2"><Button disabled={busy || !setup || !sources.length || !qualified || !nonTrade || !values.pair || !values.book || !values.elimination || !values.oci || !values.pnl || (values.evidence?.trim().length ?? 0)<40 || (values.reason?.trim().length ?? 0)<8} onClick={()=>void save()}>{t('propose')}</Button><Button variant="outline" disabled={busy} onClick={guard.close}>{common('actions.cancel')}</Button></div>
  </div></Drawer> : null}</>
}
