'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button,SearchSelect } from '@openbooks/ui'
import { promptDialog } from '@/lib/prompt'
import { fetchAppAction } from '@/lib/api-error'
import { toast } from 'sonner'

export function GlAuditNumberCommand({bookId,periods,entities}: {bookId:string;periods:{value:string;label:string}[];entities:{value:string;label:string}[]}) {
 const t=useTranslations('reports.journalMeasurements')
 const router=useRouter()
 const [periodId,setPeriodId]=useState(periods[0]?.value ?? '')
 const [subsidiaryId,setSubsidiaryId]=useState(entities[0]?.value ?? '')
 const [busy,setBusy]=useState(false)
 async function allocate() {
  const reason=await promptDialog({title:t('allocateTitle'),message:t('allocateDescription'),label:t('reason'),placeholder:t('reason')})
  if (!reason) return
  setBusy(true)
  try {await fetchAppAction('/api/close/gl-audit-numbers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({periodId,subsidiaryId,bookId,reason})});toast.success(t('allocated'));router.refresh()}
  catch(error) {toast.error(error instanceof Error ? error.message : t('failed'))}
  finally {setBusy(false)}
 }
 return <div className="flex flex-wrap items-center gap-3"><SearchSelect value={periodId} onChange={setPeriodId} options={periods} placeholder={t('period')} /><SearchSelect value={subsidiaryId} onChange={setSubsidiaryId} options={entities} placeholder={t('entity')} /><Button variant="outline" disabled={busy || !periodId || !subsidiaryId} onClick={allocate}>{t('allocate')}</Button></div>
}
