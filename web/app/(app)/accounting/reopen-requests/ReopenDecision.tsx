'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button } from '@openbooks/ui'
import { useAppAction } from '@/lib/use-app-action'

/**
 * Approve or reject one pending reopen request through the native close
 * command. The server refuses a requester deciding their own request, so the
 * buttons are withheld there and the reason is stated instead.
 */
export function ReopenDecision({ requestId, ownRequest }: { requestId: string; ownRequest: boolean }) {
  const t = useTranslations('accounting.reopenRequests')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  if (ownRequest) return <span className="text-xs text-slate-500 dark:text-slate-400">{t('ownRequest')}</span>
  const decide = (approve: boolean) =>
    execute(
      () =>
        fetchAction('/api/admin/close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'decide-reopen', requestId, approve }),
        }),
      {
        fallbackMessage: t('decideFailed'),
        successMessage: approve ? t('approved') : t('rejected'),
        onOk: () => router.refresh(),
      },
    )
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>{t('reject')}</Button>
        <Button size="sm" disabled={busy} onClick={() => void decide(true)}>{t('approve')}</Button>
      </div>
      <ActionAlert error={refusal} fallbackMessage={t('decideFailed')} />
    </div>
  )
}
