'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { LeaveDrawer } from './LeaveDrawer'
import type { LeaveQueueRow } from '../../../../lib/hrm/leave'

/**
 * The org-wide leave queue body. Rows arrive loader-resolved (newest start
 * first, already segment-filtered); this island only opens the LeaveDrawer
 * for filing and detail, and reuses the leave API routes and their refusals
 * for withdraw and cancel. res.ok is checked before any body is parsed.
 * Approval outcomes stay in native Approvals: this surface only files,
 * submits, withdraws, and cancels — the drawer deep-links the approval run
 * for the decision itself.
 */

export function LeaveQueue({
  rows,
  columns,
  canFile,
  canRecord,
  fileTitle,
  fileButton,
  recordTitle,
  recordButton,
  emptyTitle,
  emptyDescription,
  truncated,
  truncatedNote,
  notAvailable,
  openEmployee,
}: {
  rows: LeaveQueueRow[]
  columns: { employee: string; type: string; range: string; hours: string }
  canFile: boolean
  canRecord: boolean
  fileTitle: string
  fileButton: string
  recordTitle: string
  recordButton: string
  emptyTitle: string
  emptyDescription: string
  truncated: boolean
  truncatedNote: string
  notAvailable: string
  openEmployee: string
}) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [filing, setFiling] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const statusLabel = (status: string): string =>
    t.has(`leave.statusNames.${status}`) ? t(`leave.statusNames.${status}`) : status

  return (
    <div>
      {canFile || canRecord ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {canFile ? fileTitle : recordTitle}
          </p>
          <div className="flex gap-2">
            {canRecord ? (
              <Button size="sm" variant="outline" onClick={() => setFiling(true)}>
                {recordButton}
              </Button>
            ) : null}
            {canFile ? <Button size="sm" onClick={() => setFiling(true)}>{fileButton}</Button> : null}
          </div>
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
              <th className="px-3 py-2 text-left font-medium">{columns.type}</th>
              <th className="px-3 py-2 text-left font-medium">{columns.range}</th>
              <th className="px-3 py-2 text-right font-medium">{columns.hours}</th>
              <th className="px-4 py-2 text-right font-medium">
                <span className="sr-only">{columns.hours}</span>
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
                <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400">{row.leaveTypeCode}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-500 dark:text-slate-400">
                  {row.startsOn} → {row.endsOn}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {row.hours}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="mb-1.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    {statusLabel(row.status)}
                  </span>
                  <span className="block">
                    <button
                      type="button"
                      className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      onClick={() => setOpenId(row.id)}
                    >
                      {t('leave.openRequest')}
                    </button>
                  </span>
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
      {filing ? (
        <LeaveDrawer
          requestId={null}
          onClose={() => {
            setFiling(false)
            router.refresh()
          }}
        />
      ) : null}
      {openId ? (
        <LeaveDrawer
          key={openId}
          requestId={openId}
          onClose={() => {
            setOpenId(null)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}
