'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button, Drawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { ChangeRequestActions } from '../ChangeRequestActions'

/**
 * Request-detail drawer for the change-request queue (?request=<id>).
 * Opens from a row's open link or a shareable URL and closes by navigating
 * the param away (the dialog island owns that navigation).
 *
 * The drawer fetches the single-request API route, which enforces the
 * kind-aware read gate per row: a permitted request renders subject,
 * proposed change, reason, history, and decision context with the existing
 * lifecycle actions inside; an out-of-scope id renders the service's named
 * refusal with its message intact — res.ok is checked before anything is
 * parsed, and no data renders beside a refusal. Approval outcomes stay in
 * native Approvals (deep-linked from the decision section): this surface
 * never duplicates the governed decision path.
 */

export interface ChangeRequestDetailSubject {
  employeeLabel: string
  kindLabel: string
  effectiveWindow: string
  requesterLabel: string
  submittedLabel: string
  statusLabel: string
}

interface DetailRequest {
  id: string
  employmentId: string
  payload: Record<string, unknown>
  reason: string | null
  action: string | null
  reasonCode: string | null
  status: string
  submittedBy: string | null
  submittedAt: string | null
  flowRunId: string | null
  decisionSnapshot: {
    outcome?: unknown
    gates?: unknown
  } | null
  appliedAt: string | null
  appliedBy: string | null
  appliedEmploymentChangeId: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

interface SnapshotGate {
  decision: unknown
  decided_by: unknown
  decided_at: unknown
  comment: unknown
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * One display-name lookup over the existing HRM options route (the same
 * bounded, include-pinned read the authoring pickers use): the stored
 * payload carries foreign-key ids, the drawer shows labels, never ids.
 * An unresolvable id stays null and the caller falls back to the
 * not-available line — never a raw uuid as primary display.
 */
function useOptionLabel(
  source: 'employments' | 'locations' | 'positions',
  id: string | null,
  idField: 'employmentId' | 'locationId' | 'positionId',
): string | null {
  const [label, setLabel] = useState<string | null>(null)
  const requestId = useRef(0)
  useEffect(() => {
    // No synchronous reset: while id is null the caller renders nothing
    // from this hook, and a new request remounts the drawer (keyed by
    // request id), so a stale label can never survive a navigation.
    if (!id) return
    const seq = (requestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', source)
    params.set('limit', '1')
    params.set('include', id)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (seq !== requestId.current) return
        if (!res.ok) {
          setLabel(null)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: Record<string, unknown>[]
        }
        if (seq !== requestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const match = page.find((row) => row[idField] === id)
        const found = match && typeof match.label === 'string' ? match.label : null
        setLabel(found)
      })
      .catch(() => {
        if (seq === requestId.current) setLabel(null)
      })
    // No cleanup: the sequence guard drops stale responses, and a single
    // bounded read needs no abort.
  }, [source, id, idField])
  return label
}

export function ChangeRequestDetailDrawer({
  requestId,
  subject,
  departmentOptions,
  onClose,
}: {
  requestId: string
  /** Loader-resolved subject labels when the id is in the visible list; null
   * on a deep link into another segment — the live fetch still resolves. */
  subject: ChangeRequestDetailSubject | null
  departmentOptions: { value: string; label: string }[]
  onClose: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [detail, setDetail] = useState<DetailRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<string | undefined>(undefined)

  useEffect(() => {
    // No synchronous reset here: the dialog keys this drawer by request
    // id, so a new request mounts fresh state (loading) instead of
    // reusing a previous request's detail.
    let live = true
    fetch(`/api/hrm/change-requests/${requestId}`, { method: 'GET' })
      .then(async (res) => {
        if (!live) return
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, t('queue.detailFailed')))
          setLoading(false)
          return
        }
        const payload = (await res.json().catch(() => null)) as { request?: unknown } | null
        const request =
          payload !== null && typeof payload === 'object' && payload.request !== null && typeof payload.request === 'object'
            ? (payload.request as DetailRequest)
            : null
        if (!request || typeof request.payload !== 'object' || request.payload === null) {
          setStatus(t('queue.detailFailed'))
          setLoading(false)
          return
        }
        setDetail(request)
        setStatus(undefined)
        setLoading(false)
      })
      .catch(() => {
        if (!live) return
        setStatus(t('queue.detailFailed'))
        setLoading(false)
      })
    return () => {
      live = false
    }
  }, [requestId, t])

  const payload = detail?.payload ?? {}
  const kind = asText(payload.kind) ?? ''
  const kindLabel = (value: string): string =>
    value === 'hire'
      ? t('employment.changeRequests.kindHire')
      : value === 'status_change'
        ? t('employment.changeRequests.kindStatusChange')
        : value === 'assignment_change'
          ? t('employment.changeRequests.kindAssignmentChange')
          : value === 'termination'
            ? t('employment.changeRequests.kindTermination')
            : value === 'position_assignment'
              ? t('employment.changeRequests.kindPositionAssignment')
              : value
  const statusLabelOf = (value: string): string =>
    t.has(`employment.changeRequests.statusNames.${value}`)
      ? t(`employment.changeRequests.statusNames.${value}`)
      : value
  // Civil dates travel verbatim: the stored payload carries YYYY-MM-DD
  // strings and the drawer renders them untouched, never through a Date.
  const effectiveWindow = ((): string => {
    if (kind === 'termination') return asText(payload.effectiveDate) ?? t('queue.notAvailable')
    const from = asText(payload.effectiveFrom)
    if (!from) return t('queue.notAvailable')
    const to = asText(payload.effectiveTo)
    return to ? `${from} → ${to}` : `${from} → ${t('employment.episodes.present')}`
  })()
  const departmentName = ((): string | null => {
    const id = asText(payload.departmentId)
    if (!id) return null
    return departmentOptions.find((option) => option.value === id)?.label ?? null
  })()
  const locationName = useOptionLabel('locations', asText(payload.locationId), 'locationId')
  const managerName = useOptionLabel('employments', asText(payload.managerEmploymentId), 'employmentId')
  const positionName = useOptionLabel('positions', asText(payload.positionId), 'positionId')
  const employeeName = useOptionLabel('employments', detail?.employmentId ?? null, 'employmentId')

  // Proposed-change rows: known payload fields render under their catalog
  // labels (the authoring drawer's field order); any future field the
  // contract adds renders under its raw key rather than being dropped from
  // a review it was filed for.
  const rows: { key: string; label: string; value: string }[] = []
  const take = (key: string, label: string, value: string | null): void => {
    if (value !== null) rows.push({ key, label, value })
  }
  take('status', t('employment.changeRequests.statusLabel'), asText(payload.status) !== null
    ? t.has(`employment.status.${payload.status as string}`)
      ? t(`employment.status.${payload.status as string}`)
      : (payload.status as string)
    : null)
  take('effectiveFrom', t('employment.changeRequests.effectiveFromLabel'), asText(payload.effectiveFrom))
  take('effectiveTo', t('employment.changeRequests.effectiveToLabel'), asText(payload.effectiveTo))
  take('effectiveDate', t('employment.changeRequests.effectiveDateLabel'), asText(payload.effectiveDate))
  take('assignmentKey', t('employment.changeRequests.assignmentKeyLabel'), asText(payload.assignmentKey))
  take('jobTitle', t('employment.changeRequests.jobTitleLabel'), asText(payload.jobTitle))
  if (asText(payload.departmentId) !== null) {
    rows.push({
      key: 'departmentId',
      label: t('employment.changeRequests.departmentLabel'),
      value: departmentName ?? t('queue.notAvailable'),
    })
  }
  if (asText(payload.locationId) !== null) {
    rows.push({
      key: 'locationId',
      label: t('employment.changeRequests.locationLabel'),
      value: locationName ?? t('queue.notAvailable'),
    })
  }
  take('fte', t('employment.changeRequests.fteLabel'), asText(payload.fte))
  if (typeof payload.isPrimary === 'boolean') {
    rows.push({
      key: 'isPrimary',
      label: t('employment.changeRequests.primaryLabel'),
      value: payload.isPrimary
        ? t('employment.changeRequests.primaryYes')
        : t('employment.changeRequests.primaryNo'),
    })
  }
  if (asText(payload.managerEmploymentId) !== null) {
    rows.push({
      key: 'managerEmploymentId',
      label: t('employment.changeRequests.managerLabel'),
      value: managerName ?? t('queue.notAvailable'),
    })
  }
  if ('positionId' in payload && kind === 'position_assignment') {
    rows.push({
      key: 'positionId',
      label: t('employment.changeRequests.positionLabel'),
      value:
        payload.positionId === null
          ? t('employment.changeRequests.unassignLabel')
          : (positionName ?? t('queue.notAvailable')),
    })
  }
  const knownKeys = new Set([
    'kind', 'status', 'effectiveFrom', 'effectiveTo', 'effectiveDate', 'assignmentKey', 'jobTitle',
    'departmentId', 'locationId', 'fte', 'isPrimary', 'managerEmploymentId', 'positionId',
  ])
  for (const [key, value] of Object.entries(payload)) {
    if (knownKeys.has(key)) continue
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      rows.push({ key, label: key, value: value === null ? t('queue.notAvailable') : String(value) })
    }
  }

  const actionLabel = ((): string | null => {
    if (!detail || !detail.action) return null
    const named = t.has(`options.hrmAction.${detail.action}`)
      ? t(`options.hrmAction.${detail.action}`)
      : detail.action
    return detail.reasonCode ? `${named} · ${detail.reasonCode}` : named
  })()
  const snapshotGates: SnapshotGate[] = ((): SnapshotGate[] => {
    const gates = detail?.decisionSnapshot?.gates
    if (!Array.isArray(gates)) return []
    return gates.filter(
      (gate): gate is SnapshotGate => gate !== null && typeof gate === 'object',
    )
  })()
  const outcome = asText(detail?.decisionSnapshot?.outcome)

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={t('queue.detailTitle')}
      description={
        subject
          ? `${subject.employeeLabel} · ${subject.kindLabel}`
          : detail
            ? kindLabel(kind)
            : undefined
      }
    >
      <div className="space-y-5">
        <section aria-label={t('queue.detailSubject')}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">{t('queue.columns.employee')}</dt>
            <dd className="font-medium">{subject?.employeeLabel ?? employeeName ?? (loading ? '…' : t('queue.notAvailable'))}</dd>
            <dt className="text-slate-500">{t('employment.changeRequests.kindLabel')}</dt>
            <dd>{subject?.kindLabel ?? (detail ? kindLabel(kind) : (loading ? '…' : t('queue.notAvailable')))}</dd>
            <dt className="text-slate-500">{t('queue.columns.effective')}</dt>
            <dd className="tabular-nums">{subject?.effectiveWindow ?? (detail ? effectiveWindow : (loading ? '…' : t('queue.notAvailable')))}</dd>
            <dt className="text-slate-500">{t('employment.changeRequests.statusLabel')}</dt>
            <dd>{subject?.statusLabel ?? (detail ? statusLabelOf(detail.status) : (loading ? '…' : t('queue.notAvailable')))}</dd>
          </dl>
        </section>
        {loading ? <p className="text-sm text-slate-500">{t('queue.detailLoading')}</p> : null}
        {status ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {status}
          </p>
        ) : null}
        {!loading && !status && detail ? (
          <>
            <section aria-label={t('queue.detailProposedChange')}>
              <p className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t('queue.detailProposedChange')}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {rows.map((row) => (
                  <span key={row.key} className="contents">
                    <dt className="text-slate-500">{row.label}</dt>
                    <dd className="tabular-nums">{row.value}</dd>
                  </span>
                ))}
              </dl>
              {actionLabel ? (
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {t('employment.changeRequests.actionLabel')}: {actionLabel}
                </p>
              ) : null}
            </section>
            {detail.reason ? (
              <section aria-label={t('employment.changeRequests.reasonLabel')}>
                <p className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('employment.changeRequests.reasonLabel')}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-300">{detail.reason}</p>
              </section>
            ) : null}
            <section aria-label={t('queue.detailHistory')}>
              <p className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t('queue.detailHistory')}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-slate-500">{t('queue.detailCreated')}</dt>
                <dd className="tabular-nums">{detail.createdAt}</dd>
                <dt className="text-slate-500">{t('employment.changeRequests.submitted')}</dt>
                <dd className="tabular-nums">
                  {subject
                    ? `${subject.requesterLabel} · ${subject.submittedLabel}`
                    : (detail.submittedAt ?? t('queue.notAvailable'))}
                </dd>
                {detail.appliedAt ? (
                  <>
                    <dt className="text-slate-500">{t('queue.detailApplied')}</dt>
                    <dd className="tabular-nums">{detail.appliedAt}</dd>
                  </>
                ) : null}
              </dl>
            </section>
            <section aria-label={t('queue.detailDecision')}>
              <p className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t('queue.detailDecision')}
              </p>
              {outcome ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{statusLabelOf(outcome)}</p>
                  {snapshotGates.map((gate, index) => (
                    <div key={index} className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
                      <p className="font-medium">
                        {(() => {
                          const decision = asText(gate.decision)
                          return decision ? statusLabelOf(decision) : t('queue.notAvailable')
                        })()}
                      </p>
                      {asText(gate.comment) ? (
                        <p className="mt-1 text-slate-600 dark:text-slate-300">{asText(gate.comment)}</p>
                      ) : null}
                      {asText(gate.decided_at) ? (
                        <p className="mt-1 tabular-nums text-slate-500">{asText(gate.decided_at)}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : detail.status === 'pending_approval' ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {t('queue.detailAwaitingDecision')}{' '}
                  {detail.flowRunId ? (
                    <Link href="/inbox" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {t('employment.changeRequests.viewInApprovals')}
                    </Link>
                  ) : null}
                </p>
              ) : detail.status === 'draft' || !detail.flowRunId ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">{t('employment.changeRequests.noRun')}</p>
              ) : (
                <p className="text-sm text-slate-600 dark:text-slate-300">{t('queue.detailNoDecision')}</p>
              )}
            </section>
            <ChangeRequestActions
              request={{ id: detail.id, status: detail.status }}
              employmentId={detail.employmentId}
              appliedChangeId={detail.appliedEmploymentChangeId}
              departmentOptions={departmentOptions}
              onChanged={() => router.refresh()}
            />
          </>
        ) : null}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {tCommon('actions.close')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
