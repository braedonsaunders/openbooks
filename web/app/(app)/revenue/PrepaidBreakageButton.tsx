'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button,Drawer,Input,Label,SearchSelect,Select,Textarea } from '@openbooks/ui'
import { MoneyInput,moneyFieldError } from '@/components/money-input'
import { useBusinessToday } from '@/components/business-date-provider'
import { useDirtyClose } from '@/lib/use-dirty-close'
import { readApiErrorMessage } from '@/lib/api-error'
import type { breakageGrantOptions } from '@openbooks/engine/revenue'
/** Composes the contract-modification editor's native Drawer, controls and
 * dirty-close behavior. Applying an approved estimate updates the same usage
 * recognition schedules shown by this contract. */
export function PrepaidBreakageButton({grants}:{grants:Awaited<ReturnType<typeof breakageGrantOptions>>}) {
  const t=useTranslations('revenue.breakage'),common=useTranslations('common'),router=useRouter(),today=useBusinessToday()
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const [values,setValues]=useState<Record<string,string>>({date:today,method:'expected_proportional'})
  const [key,setKey]=useState(()=>crypto.randomUUID()),[initialKey,setInitialKey]=useState(key)
  const update=(field:string,value:string)=>{setValues(current=>({...current,[field]:value}));setKey(crypto.randomUUID())}
  const close=()=>{setOpen(false);setValues({date:today,method:'expected_proportional'});setError(null);const next=crypto.randomUUID();setKey(next);setInitialKey(next)}
  const guard=useDirtyClose({dirty:key!==initialKey,busy,onClose:close,message:common('feedback.unsavedChanges'),confirmLabel:common('confirm.discardChanges')})
  const yesNo=(field:string)=><div className="space-y-1"><Label htmlFor={`breakage-${field}`}>{t(field)}</Label>
    <Select id={`breakage-${field}`} value={values[field] ?? ''} onChange={event=>update(field,event.target.value)}><option value="">{t('choose')}</option><option value="yes">{common('labels.yes')}</option><option value="no">{common('labels.no')}</option></Select></div>
  async function save(){setBusy(true);setError(null);try{
    const response=await fetch('/api/revenue/breakage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grantId:values.grant,effectiveOn:values.date,reason:values.reason,idempotencyKey:key,
      estimate:{method:values.method,expectedBreakage:values.amount,entitled:values.entitled==='yes',meetsReversalConstraint:values.constraint==='yes',thirdPartyObligation:values.thirdParty==='yes',evidence:values.evidence}})})
    if(!response.ok)throw new Error(await readApiErrorMessage(response,t('failed')))
    const result=await response.json() as {id:string};close();router.push(`/accounting/changes?change=${result.id}`);router.refresh()
  }catch(caught){setError(caught instanceof Error ? caught.message : t('failed'))}finally{setBusy(false)}}
  return <><Button variant="outline" onClick={()=>setOpen(true)}>{t('title')}</Button>{open ? <Drawer open title={t('title')} onClose={guard.close} size="lg"><div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t('hint')}</p>
    <div className="space-y-1"><Label>{t('grant')}</Label><SearchSelect ariaLabel={t('grant')} value={values.grant ?? ''} onChange={value=>update('grant',value)} options={grants.map(grant=>({value:grant.id,label:`${grant.description} · ${grant.amount} ${grant.currency}`}))} placeholder={t('choose')} /></div>
    <div className="space-y-1"><Label htmlFor="breakage-date">{t('date')}</Label><Input id="breakage-date" type="date" value={values.date ?? ''} onChange={event=>update('date',event.target.value)} /></div>
    <div className="space-y-1"><Label htmlFor="breakage-method">{t('method')}</Label><Select id="breakage-method" value={values.method ?? 'expected_proportional'} onChange={event=>update('method',event.target.value)}><option value="expected_proportional">{t('expected_proportional')}</option><option value="remaining_use_remote">{t('remaining_use_remote')}</option></Select></div>
    <MoneyInput value={values.amount ?? ''} onChange={value=>update('amount',value)} field={t('amount')} ariaLabel={t('amount')} required />
    {yesNo('entitled')}{yesNo('constraint')}{yesNo('thirdParty')}
    <div className="space-y-1"><Label htmlFor="breakage-evidence">{t('evidence')}</Label><Textarea id="breakage-evidence" value={values.evidence ?? ''} onChange={event=>update('evidence',event.target.value)} maxLength={10000} /></div>
    <div className="space-y-1"><Label htmlFor="breakage-reason">{t('reason')}</Label><Textarea id="breakage-reason" value={values.reason ?? ''} onChange={event=>update('reason',event.target.value)} maxLength={1000} /></div>
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    <div className="flex gap-2"><Button disabled={busy || !values.grant || !values.entitled || !values.constraint || !values.thirdParty || (values.evidence?.trim().length ?? 0)<40 || (values.reason?.trim().length ?? 0)<8 || moneyFieldError(t('amount'),'a money amount',values.amount ?? '',4,{required:true})!==null} onClick={()=>void save()}>{t('propose')}</Button><Button variant="outline" disabled={busy} onClick={guard.close}>{common('actions.cancel')}</Button></div>
  </div></Drawer> : null}</>
}
