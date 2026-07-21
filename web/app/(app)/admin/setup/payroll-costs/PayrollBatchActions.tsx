'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function PayrollBatchActions({ batchId, status, accountingMode }: { batchId: string; status: string; accountingMode: string }) {
  const t = useTranslations('admin.setup.payrollOperations')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function run(action: 'validate' | 'reconcile' | 'post') {
    setBusy(true)
    try {
      const response = await fetch('/api/admin/setup/payroll-costs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, batchId }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || t('failed'))
      if (action === 'validate' && !payload.valid) toast.error(t('exceptionsFound', { count: payload.errors?.length ?? 0 }))
      else toast.success(t(action === 'validate' ? 'validated' : action === 'reconcile' ? 'reconciled' : 'posted'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }
  if (status === 'posted') return <span className="text-xs text-slate-500">{t('complete')}</span>
  if (status === 'draft') return <Button size="sm" variant="outline" disabled={busy} onClick={() => run('validate')}>{t('validate')}</Button>
  if (status === 'validated') return <Button size="sm" variant="outline" disabled={busy} onClick={() => run('reconcile')}>{t('reconcile')}</Button>
  return <Button size="sm" disabled={busy} onClick={() => run('post')}>
    {t(accountingMode === 'costing_only' ? 'completeCosting' : 'postVariance')}
  </Button>
}
