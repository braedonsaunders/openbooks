'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button,Drawer,Input,Label,SearchSelect,Select,Textarea } from '@openbooks/ui'
import { useBusinessToday } from '@/components/business-date-provider'
import { useDirtyClose } from '@/lib/use-dirty-close'
import { readApiErrorMessage } from '@/lib/api-error'
export function DropShipAssessmentButton({lines,accounts}:{lines:{id:string;label:string}[];accounts:{id:string;label:string}[]}) {
  const t=useTranslations('salesOrders.agency'),common=useTranslations('common'),router=useRouter(),today=useBusinessToday()
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const [values,setValues]=useState<Record<string,string>>({date:today}),[key,setKey]=useState(()=>crypto.randomUUID()),[initialKey,setInitialKey]=useState(key)
  const update=(field:string,value:string)=>{setValues(current=>({...current,[field]:value}));setKey(crypto.randomUUID())}
  const close=()=>{setOpen(false);setValues({date:today});setError(null);const next=crypto.randomUUID();setKey(next);setInitialKey(next)}
  const guard=useDirtyClose({dirty:key!==initialKey,busy,onClose:close,message:common('feedback.unsavedChanges'),confirmLabel:common('confirm.discardChanges')})
  async function save(){setBusy(true);setError(null);try{
    const response=await fetch('/api/sales-orders/agency-assessments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({salesOrderLineId:values.line,controlsBeforeTransfer:values.control==='yes',passThroughAccountId:values.control==='no' ? values.account : null,controlEvidence:values.evidence,effectiveOn:values.date,reason:values.reason,idempotencyKey:key})})
    if(!response.ok)throw new Error(await readApiErrorMessage(response,t('failed')))
    const result=await response.json() as {id:string};close();router.push(`/accounting/changes?change=${result.id}`);router.refresh()
  }catch(caught){setError(caught instanceof Error ? caught.message : t('failed'))}finally{setBusy(false)}}
  return <><Button variant="outline" onClick={()=>setOpen(true)}>{t('title')}</Button>{open ? <Drawer open title={t('title')} onClose={guard.close} size="lg"><div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t('hint')}</p>
    <div className="space-y-1"><Label>{t('line')}</Label><SearchSelect ariaLabel={t('line')} value={values.line ?? ''} onChange={value=>update('line',value)} options={lines.map(line=>({value:line.id,label:line.label}))} placeholder={t('choose')} /></div>
    <div className="space-y-1"><Label htmlFor="agency-date">{t('date')}</Label><Input id="agency-date" type="date" value={values.date ?? ''} onChange={event=>update('date',event.target.value)} /></div>
    <div className="space-y-1"><Label htmlFor="agency-control">{t('control')}</Label><Select id="agency-control" value={values.control ?? ''} onChange={event=>update('control',event.target.value)}><option value="">{t('choose')}</option><option value="yes">{t('principal')}</option><option value="no">{t('agent')}</option></Select></div>
    {values.control==='no' ? <div className="space-y-1"><Label>{t('account')}</Label><SearchSelect ariaLabel={t('account')} value={values.account ?? ''} onChange={value=>update('account',value)} options={accounts.map(account=>({value:account.id,label:account.label}))} placeholder={t('choose')} /></div> : null}
    <div className="space-y-1"><Label htmlFor="agency-evidence">{t('evidence')}</Label><Textarea id="agency-evidence" value={values.evidence ?? ''} onChange={event=>update('evidence',event.target.value)} maxLength={10000} /></div>
    <div className="space-y-1"><Label htmlFor="agency-reason">{t('reason')}</Label><Textarea id="agency-reason" value={values.reason ?? ''} onChange={event=>update('reason',event.target.value)} maxLength={1000} /></div>
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    <div className="flex gap-2"><Button disabled={busy || !values.line || !values.control || (values.control==='no' && !values.account) || (values.evidence?.trim().length ?? 0)<40 || (values.reason?.trim().length ?? 0)<8} onClick={()=>void save()}>{t('propose')}</Button><Button variant="outline" disabled={busy} onClick={guard.close}>{common('actions.cancel')}</Button></div>
  </div></Drawer> : null}</>
}
