'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, SearchSelect } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { ChangeRequestActions } from '../ChangeRequestActions'
import { ChangeRequestDrawer } from '../ChangeRequestDrawer'
import type { QueueRow } from '../../../../lib/hrm/change-requests'

/**
 * The org-wide change-request queue body. Rows arrive loader-resolved
 * (newest first, already segment-filtered); this island only opens the
 * existing ChangeRequestDrawer for propose/edit and reuses
 * ChangeRequestActions plus the existing API routes and their refusals for
 * every lifecycle transition. res.ok is checked before any body is parsed.
 */

export function ChangeRequestQueue({
  rows,
  columns,
  canManage,
  departmentOptions,
  proposeTitle,
  proposeButton,
  proposeEmploymentLabel,
  proposeEmploymentPlaceholder,
  proposeEmpty,
  proposeFailed,
  draftBadge,
  openEmployee,
  notAvailable,
  emptyTitle,
  emptyDescription,
  truncated,
  truncatedNote,
}: {
  rows: QueueRow[]
  columns: { employee: string; kind: string; effective: string; requester: string; submitted: string }
  canManage: boolean
  departmentOptions: { value: string; label: string }[]
  proposeTitle: string
  proposeButton: string
  proposeEmploymentLabel: string
  proposeEmploymentPlaceholder: string
  proposeEmpty: string
  proposeFailed: string
  draftBadge: string
  openEmployee: string
  notAvailable: string
  emptyTitle: string
  emptyDescription: string
  truncated: boolean
  truncatedNote: string
}) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [proposing, setProposing] = useState(false)

  const kindLabel = (kind: string): string => {
    const key =
      kind === 'hire'
        ? 'kindHire'
        : kind === 'status_change'
          ? 'kindStatusChange'
          : kind === 'assignment_change'
            ? 'kindAssignmentChange'
            : kind === 'termination'
              ? 'kindTermination'
              : null
    return key !== null ? t(`employment.changeRequests.${key}`) : kind
  }
  const statusLabel = (status: string): string =>
    t.has(`employment.changeRequests.statusNames.${status}`)
      ? t(`employment.changeRequests.statusNames.${status}`)
      : status
  const window = (from: string | null, to: string | null): string =>
    from === null ? notAvailable : `${from} → ${to ?? t('employment.episodes.present')}`

  return (
    <div>
      {canManage ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{proposeTitle}</p>
          <Button size="sm" onClick={() => setProposing(true)}>
            {proposeButton}
          </Button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{emptyTitle}</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{emptyDescription}</p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">{columns.employee}</th>
              <th className="px-3 py-2 text-left font-medium">{columns.kind}</th>
              <th className="px-3 py-2 text-left font-medium">{columns.effective}</th>
              <th className="px-3 py-2 text-left font-medium">{columns.requester}</th>
              <th className="px-3 py-2 text-left font-medium">{columns.submitted}</th>
              <th className="px-4 py-2 text-right font-medium">
                <span className="sr-only">{draftBadge}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-50 align-top last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2.5 font-medium text-slate-700 dark:text-slate-200">
                  {row.partyId ? (
                    <Link
                      href={`/entities/employees?party=${row.partyId}` as never}
                      title={openEmployee}
                      className="hover:underline"
                    >
                      {row.employeeName ?? notAvailable}
                    </Link>
                  ) : (
                    (row.employeeName ?? notAvailable)
                  )}
                </td>
                <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400">{kindLabel(row.kind)}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-500 dark:text-slate-400">
                  {window(row.effectiveFrom, row.effectiveTo)}
                </td>
                <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400">{row.requesterName ?? notAvailable}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-500 dark:text-slate-400">
                  {row.submittedAt ?? notAvailable}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="mb-1.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    {statusLabel(row.status)}
                  </span>
                  {canManage ? (
                    <span className="block">
                      <ChangeRequestActions
                        request={{ id: row.id, status: row.status }}
                        employmentId={row.employmentId}
                        departmentOptions={departmentOptions}
                        onChanged={() => router.refresh()}
                      />
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {truncated ? (
        <p className="border-t border-slate-100 px-4 py-2.5 text-center text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
          {truncatedNote}
        </p>
      ) : null}
      {proposing && canManage ? (
        <ProposeEmploymentPicker
          departmentOptions={departmentOptions}
          employmentLabel={proposeEmploymentLabel}
          employmentPlaceholder={proposeEmploymentPlaceholder}
          emptyLabel={proposeEmpty}
          requestFailed={proposeFailed}
          onClose={() => setProposing(false)}
          onSaved={() => {
            setProposing(false)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Propose-entry point for the queue: pick the employment first (the drawer
 * itself is per-employment), then hand off to the existing authoring
 * drawer. Options ride the existing HRM options route with its refusals.
 */
function ProposeEmploymentPicker({
  departmentOptions,
  employmentLabel,
  employmentPlaceholder,
  emptyLabel,
  requestFailed,
  onClose,
  onSaved,
}: {
  departmentOptions: { value: string; label: string }[]
  employmentLabel: string
  employmentPlaceholder: string
  emptyLabel: string
  requestFailed: string
  onClose: () => void
  onSaved: () => void
}) {
  const tCommon = useTranslations('common')
  const [employmentId, setEmploymentId] = useState('')
  const [options, setOptions] = useState<{ value: string; label: string }[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const requestId = useRef(0)

  useEffect(() => {
    const id = (requestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', 'employments')
    params.set('limit', '25')
    if (query.trim()) params.set('q', query.trim())
    if (employmentId) params.set('include', employmentId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== requestId.current) return
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, requestFailed))
          setLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { employmentId?: unknown; label?: unknown }[]
        }
        if (id !== requestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged: { value: string; label: string }[] = []
        for (const row of page) {
          if (typeof row.employmentId === 'string' && typeof row.label === 'string') {
            merged.push({ value: row.employmentId, label: row.label })
          }
        }
        if (employmentId && !merged.some((option) => option.value === employmentId)) {
          merged.push({ value: employmentId, label: employmentId })
        }
        setOptions(merged)
        setStatus(undefined)
        setLoading(false)
      })
      .catch(() => {
        if (id !== requestId.current) return
        setStatus(requestFailed)
        setLoading(false)
      })
  }, [query, employmentId, requestFailed])

  if (employmentId) {
    return (
      <ChangeRequestDrawer
        employmentId={employmentId}
        initialRequest={null}
        departmentOptions={departmentOptions}
        onClose={onClose}
        onSaved={onSaved}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={employmentLabel}>
      <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{employmentLabel}</p>
        <SearchSelect
          id="queue-propose-employment"
          value={employmentId}
          onChange={(next) => setEmploymentId(next)}
          options={options}
          ariaLabel={employmentLabel}
          sheetTitle={employmentLabel}
          emptyLabel={employmentPlaceholder || emptyLabel}
          remote
          loading={loading}
          statusMessage={status}
          statusTone={status ? 'error' : 'muted'}
          onSearchChange={(next) => {
            setQuery(next)
            setLoading(true)
            setStatus(undefined)
          }}
        />
        {status ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {status}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
