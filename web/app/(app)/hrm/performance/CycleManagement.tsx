'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Input, Label, Select, Badge } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { RecordTabs } from '../../../../components/module-home/record-tabs'
import { useDirtyUrlDrawer } from '../../../../components/dirty-url-drawer'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { confirmDialog } from '../../../../lib/confirm'
import { CycleActions } from './CycleActions'
import type { PerformancePageData } from './view'
type Detail = NonNullable<PerformancePageData['detail']>
export function CycleManagement({ detail }: { detail: Detail }) {
  const t = useTranslations('hrm.talentWorkspace'),
    fmt = useFormatter(),
    router = useRouter()
  const [tab, setTab] = useState<'participants' | 'settings' | 'history'>(
    'participants',
  )
  const [management, setManagement] = useState(detail.management!)
  const [name, setName] = useState(detail.cycleName),
    [selfDue, setSelfDue] = useState(management.selfDueOn ?? ''),
    [managerDue, setManagerDue] = useState(management.managerDueOn ?? '')
  const [policy, setPolicy] = useState(management.requireManagerReviews)
  const values = JSON.stringify({ name, selfDue, managerDue, policy })
  const [baseline, setBaseline] = useState(values)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [shareResult, setShareResult] = useState('')
  useDirtyUrlDrawer(values !== baseline, busy)
  if (
    !busy &&
    detail.management &&
    values === baseline &&
    detail.management.revision > management.revision
  ) {
    setManagement(detail.management)
    setName(detail.cycleName)
    setSelfDue(detail.management.selfDueOn ?? '')
    setManagerDue(detail.management.managerDueOn ?? '')
    setPolicy(detail.management.requireManagerReviews)
    setBaseline(
      JSON.stringify({
        name: detail.cycleName,
        selfDue: detail.management.selfDueOn ?? '',
        managerDue: detail.management.managerDueOn ?? '',
        policy: detail.management.requireManagerReviews,
      }),
    )
  }
  async function update(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/hrm/review-cycles/' + detail.cycleId, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, revision: management.revision }),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('saveFailed')))
        return
      }
      const payload = (await response.json()) as {
        management?: typeof management
      }
      if (!payload.management?.revision) {
        setError(t('saveFailed'))
        return
      }
      setManagement(payload.management)
      if (body.action === 'update') setBaseline(values)
      router.refresh()
    } catch {
      setError(t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const shareable = detail.reviews.filter(
    (r) =>
      r.kind !== 'self' &&
      (r.status === 'submitted' || r.status === 'calibrated'),
  )
  async function share() {
    if (
      !(await confirmDialog({
        title: t('shareReviews'),
        message: t('shareConfirm', { count: shareable.length }),
        confirmLabel: t('shareReviews'),
      }))
    )
      return
    setBusy(true)
    setError(null)
    let succeeded = 0
    const failures: string[] = []
    try {
      for (const review of shareable) {
        try {
          const response = await fetch('/api/hrm/reviews/' + review.id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'share' }),
          })
          if (response.ok) {
            const payload = (await response.json()) as {
              review?: { id: string; status: string }
            }
            if (
              payload.review?.id === review.id &&
              payload.review.status === 'shared'
            )
              succeeded++
            else failures.push(review.kindLabel + ': ' + t('saveFailed'))
          } else
            failures.push(
              review.kindLabel +
                ': ' +
                (await readApiErrorMessage(response, t('saveFailed'))),
            )
        } catch {
          failures.push(review.kindLabel + ': ' + t('saveFailed'))
        }
      }
      setShareResult(t('sharedCount', { count: succeeded }))
      if (failures.length) setError(failures.join('\n'))
      router.refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <RecordTabs
          label={t('cycleAdministration')}
          active={tab}
          onChange={setTab}
          tabs={[
            {
              key: 'participants',
              label: t('participants'),
              count: management.participants.length,
            },
            { key: 'settings', label: t('settings') },
            { key: 'history', label: t('history') },
          ]}
        />
        {shareable.length > 0 && detail.cycleStatus !== 'calibrating' && (
          <Button size="sm" disabled={busy} onClick={() => void share()}>
            {t('shareCount', { count: shareable.length })}
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      {shareResult && (
        <p role="status" className="text-sm text-teal-700">
          {shareResult}
        </p>
      )}
      {tab === 'participants' ? (
        <>
          {management.participants.some((p) => !p.reviewerPartyId) && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {t('missingReviewers', {
                names: management.participants
                  .filter((p) => !p.reviewerPartyId)
                  .map((p) => p.name)
                  .join(', '),
              })}
            </p>
          )}
          <PagedTable
            rows={management.participants}
            rowKey={(p) => p.id}
            searchable
            empty={t('noParticipants')}
            columns={[
              {
                key: 'employee',
                header: t('employee'),
                search: (p) => p.name,
                cell: (p) => <span className="font-medium">{p.name}</span>,
              },
              {
                key: 'reviewer',
                header: t('reviewer'),
                search: (p) => p.reviewerName ?? '',
                cell: (p) =>
                  detail.cycleStatus === 'draft' ? (
                    <Select
                      aria-label={t('reviewerFor', { name: p.name })}
                      value={p.reviewerPartyId ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        void update({
                          action: 'assign-reviewer',
                          employmentId: p.id,
                          reviewerPartyId: e.target.value,
                        })
                      }
                    >
                      <option value="" disabled>
                        {t('assignReviewer')}
                      </option>
                      {management.reviewers
                        .filter((r) => r.value !== p.subjectPartyId)
                        .map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                    </Select>
                  ) : (
                    (p.reviewerName ?? '—')
                  ),
              },
              ...(['self', 'manager'] as const).map((kind) => ({
                key: kind,
                header: kind === 'self' ? t('selfReview') : t('managerReview'),
                cell: (p: (typeof management.participants)[number]) => {
                  const review = detail.reviews.find(
                    (r) => r.employmentId === p.id && r.kind === kind,
                  )
                  return review ? (
                    <a href={review.href} className="underline">
                      <Badge
                        variant={
                          review.status === 'pending' ? 'warning' : 'secondary'
                        }
                      >
                        {review.statusLabel}
                      </Badge>
                    </a>
                  ) : (
                    <span className="text-xs text-slate-500">
                      {detail.cycleStatus === 'draft'
                        ? t('notAssigned')
                        : t('noReview')}
                    </span>
                  )
                },
              })),
            ]}
          />
          <CycleActions
            cycleId={detail.cycleId}
            calibration={detail.calibration}
          />
        </>
      ) : tab === 'settings' ? (
        <form
          className="max-w-2xl space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void update({
              action: 'update',
              name,
              selfDueOn: selfDue || null,
              managerDueOn: managerDue || null,
              requireManagerReviews: policy,
            })
          }}
        >
          <fieldset
            disabled={
              busy ||
              detail.cycleStatus === 'closed' ||
              detail.cycleStatus === 'calibrating'
            }
            className="space-y-4"
          >
            <div>
              <Label htmlFor="edit-cycle-name">{t('cycleName')}</Label>
              <Input
                id="edit-cycle-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="edit-self-due">{t('selfDue')}</Label>
                <Input
                  id="edit-self-due"
                  type="date"
                  value={selfDue}
                  onChange={(e) => setSelfDue(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="edit-manager-due">{t('managerDue')}</Label>
                <Input
                  id="edit-manager-due"
                  type="date"
                  value={managerDue}
                  onChange={(e) => setManagerDue(e.target.value)}
                />
              </div>
            </div>
            {detail.cycleStatus === 'draft' && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={policy}
                  onChange={(e) => setPolicy(e.target.checked)}
                />
                {t('requireManager')}
              </label>
            )}
            <p className="text-xs text-slate-500">{t('closingDoesNotShare')}</p>
            <Button type="submit" disabled={values === baseline}>
              {t('saveSettings')}
            </Button>
          </fieldset>
        </form>
      ) : (
        <div className="space-y-3">
          {management.history.length ? (
            management.history.map((h, i) => (
              <p key={i} className="border-l-2 border-slate-200 pl-3 text-sm">
                {t.has(`events.${h.event}`) ? t(`events.${h.event}`) : h.event}{' '}
                · {h.actor ?? '—'} ·{' '}
                {fmt.dateTime(new Date(h.at), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            ))
          ) : (
            <p className="text-sm text-slate-500">{t('noHistory')}</p>
          )}
        </div>
      )}
    </div>
  )
}
