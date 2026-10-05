'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Repeat } from 'lucide-react'

import { fetchAction } from '@braedonsaunders/appkit-errors'
import { Badge, Button } from '@openbooks/ui'
import { Switch } from '../../../components/switch'
import { useAppAction } from '../../../lib/use-app-action'
import { SublistHeading } from './PartySummary'

interface EnrollmentRow {
  id: string
  subscriptionId: string | null
  subscriptionName: string | null
  status: 'active' | 'paused'
}

export function PartyAutopayPanel({ partyId, canManageAutopay }: {
  partyId: string
  canManageAutopay: boolean
}) {
  const t = useTranslations('parties.drawer.autopay')
  const tc = useTranslations('common')
  const { busy, refusal, execute } = useAppAction()
  const [enrollments, setEnrollments] = useState<EnrollmentRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [chargeOnIssue, setChargeOnIssue] = useState(false)

  // The mount effect keeps its promise-chain shape, which never resets state
  // synchronously inside the effect body; mutations refresh through the
  // same reload and apply pair.
  const reload = useCallback(async (signal?: AbortSignal) => {
    const enrollmentsRes = await fetch(`/api/autopay/enrollments?partyId=${encodeURIComponent(partyId)}`, { signal })
    if (!enrollmentsRes.ok) {
      const body = await enrollmentsRes.json().catch(() => null)
      throw new Error((body?.error as string | undefined) ?? t('loadFailed'))
    }
    const enrollmentsBody = (await enrollmentsRes.json()) as { enrollments?: EnrollmentRow[] }
    return enrollmentsBody.enrollments ?? []
  }, [partyId, t])

  const applyLoaded = useCallback((applied: EnrollmentRow[]) => {
    setEnrollments(applied)
    setLoadError(null)
  }, [])

  const applyRefusal = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    setLoadError(error instanceof Error ? error.message : t('loadFailed'))
    setEnrollments(null)
  }, [t])

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).then(applyLoaded, applyRefusal)
    return () => controller.abort()
  }, [reload, applyLoaded, applyRefusal])

  function refresh(): void {
    void reload().then(applyLoaded, applyRefusal)
  }

  async function enroll() {
    await execute(() => fetchAction(`/api/autopay/enrollments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partyId, chargeOnIssue }),
    }), {
      fallbackMessage: t('enrollFailed'),
      onOk: () => refresh(),
    })
  }

  async function moveEnrollment(id: string, status: 'active' | 'paused') {
    await execute(() => fetchAction(`/api/autopay/enrollments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }), {
      fallbackMessage: t('updateFailed'),
      onOk: () => refresh(),
    })
  }

  const customerEnrollment = enrollments?.find((row) => row.subscriptionId === null)
  const subscriptionEnrollments = enrollments?.filter((row) => row.subscriptionId !== null) ?? []

  return (
    <section className="space-y-4">
      <SublistHeading
        title={t('enrollmentHeading')}
        description={t('enrollmentDescription')}
        icon={<Repeat size={16} />}
      />
      {refusal?.serverMessage ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {refusal.serverMessage}
        </p>
      ) : null}
      {enrollments === null ? (
        loadError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => refresh()}>{t('tryAgain')}</Button>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400" aria-live="polite">{tc('feedback.loading')}</p>
        )
      ) : (
        <div className="space-y-2">
          {customerEnrollment ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Switch
                on={customerEnrollment.status === 'active'}
                disabled={busy || !canManageAutopay}
                label={t('customerScope')}
                onToggle={() => void moveEnrollment(
                  customerEnrollment.id,
                  customerEnrollment.status === 'active' ? 'paused' : 'active',
                )}
              />
              <Badge variant={customerEnrollment.status === 'active' ? 'success' : 'secondary'}>
                {customerEnrollment.status === 'active' ? t('active') : t('paused')}
              </Badge>
            </div>
          ) : canManageAutopay ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void enroll()}>
                {t('enroll')}
              </Button>
              <Switch on={chargeOnIssue} disabled={busy} label={t('chargeOnIssue')} onToggle={() => setChargeOnIssue((flag) => !flag)} />
            </div>
          ) : null}
          {subscriptionEnrollments.map((enrollment) => (
            <div key={enrollment.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Switch
                on={enrollment.status === 'active'}
                disabled={busy || !canManageAutopay}
                label={t('subscriptionScope', { name: enrollment.subscriptionName ?? enrollment.subscriptionId ?? '' })}
                onToggle={() => void moveEnrollment(
                  enrollment.id,
                  enrollment.status === 'active' ? 'paused' : 'active',
                )}
              />
              <Badge variant={enrollment.status === 'active' ? 'success' : 'secondary'}>
                {enrollment.status === 'active' ? t('active') : t('paused')}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
