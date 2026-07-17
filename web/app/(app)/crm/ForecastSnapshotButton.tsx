'use client'
import { useState } from 'react'
import { Button } from '@openbooks/ui'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
export function ForecastSnapshotButton({periodStart,periodEnd}:{periodStart:string;periodEnd:string}){const t=useTranslations('crm');const [busy,setBusy]=useState(false);async function create(){setBusy(true);try{const response=await fetch('/api/crm/forecasts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({periodStart,periodEnd})});if(!response.ok)throw new Error();toast.success(t('forecasts.snapshotCreated'))}catch{toast.error(t('forecasts.snapshotFailed'))}finally{setBusy(false)}}return <Button onClick={create} disabled={busy}>{busy?t('forecasts.savingSnapshot'):t('forecasts.saveSnapshot')}</Button>}
