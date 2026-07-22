'use client'

// Approval worklist table for flow gates. Owns the bulk-selection state
// (select-all + per-row checkboxes) and the Approve/Reject-selected actions,
// which POST to /api/flows/gates/bulk (per-item server-side iteration, no batch
// cap) and summarize the per-row results in one toast. Single-row actions stay
// on GateActions.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { promptDialog } from '../../../lib/prompt'
import { GateActions, type DelegateOption } from './GateActions'

export interface ApprovalRow {
  /** Stable selection key: `gate:${id}`. */
  key: string
  gateId: string
  documentNumber: string
  kind: string
  kindLabel: string
  /** Native module drawer deep-link (null → plain text). */
  href: string | null
  party: string | null
  /** Pre-formatted amount (server renders the org's symbol). */
  amount: string | null
  /** Gate title. */
  approvalTitle: string
  /** Flow name. */
  engineName: string
  /** ISO timestamp the approval was requested — drives the aging chip. */
  requestedAt: string
  assignee: string | null
  canDelegate: boolean
  quorumAll: boolean
  /** Gate demands a typed e-signature to approve (blocks bulk approve). */
  signatureRequired?: boolean
}

const DAY_MS = 86_400_000

/** Days pending — amber past 2, red past 5, otherwise muted. */
function Aging({ requestedAt, label }: { requestedAt: string; label: (days: number) => string }) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(requestedAt).getTime()) / DAY_MS))
  const tone =
    days > 5
      ? 'text-red-600 dark:text-red-400'
      : days > 2
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-slate-400 dark:text-slate-500'
  return <span className={`text-xs tabular-nums ${tone}`}>{label(days)}</span>
}

export function ApprovalsTable({
  rows,
  users,
  bulk,
  showAssignee,
  actionsEnabled,
}: {
  rows: ApprovalRow[]
  users: DelegateOption[]
  /** Show checkboxes + the Approve/Reject-selected toolbar. */
  bulk: boolean
  /** Extra assignee column ("All approvals" tab). */
  showAssignee: boolean
  /** Render per-row Approve/Reject/Delegate (off for read-only monitoring). */
  actionsEnabled: boolean
}) {
  const t = useTranslations('approvals')
  const tc = useTranslations('common')
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // Selection survives filters upstream; drop keys for rows no longer shown.
  const visibleSelected = useMemo(
    () => new Set(rows.filter((r) => selected.has(r.key)).map((r) => r.key)),
    [rows, selected],
  )
  const allSelected = rows.length > 0 && visibleSelected.size === rows.length
  const someSelected = visibleSelected.size > 0 && !allSelected

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))
  }
  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function runBulk(decision: 'approved' | 'rejected') {
    const chosen = rows.filter((r) => visibleSelected.has(r.key))
    if (chosen.length === 0) return
    // A signature-required gate must be approved individually (each needs its
    // own typed attestation) — bulk approve can't collect one.
    if (decision === 'approved' && chosen.some((r) => r.signatureRequired)) {
      toast.error(t('bulk.signatureBlocked'))
      return
    }
    let comment: string | undefined
    if (decision === 'rejected') {
      const reason = await promptDialog({
        title: t('bulk.rejectTitle', { count: chosen.length }),
        label: t('bulk.reasonLabel'),
        confirmLabel: tc('actions.reject'),
      })
      if (!reason) return
      comment = reason
    }
    setBusy(true)
    const items = chosen.map((r) => ({ gateId: r.gateId }))
    const res = await fetch('/api/flows/gates/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, decision, comment }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(data.error ?? t('decide.decisionFailed'))
      return
    }
    const results = (data.results ?? []) as { ok: boolean; error?: string }[]
    const ok = results.filter((r) => r.ok).length
    const failed = results.length - ok
    const okMsg =
      decision === 'approved'
        ? t('bulk.approvedCount', { count: ok })
        : t('bulk.rejectedCount', { count: ok })
    if (failed > 0) {
      const firstError = results.find((r) => !r.ok)?.error ?? ''
      toast.warning(`${okMsg}, ${t('bulk.failedCount', { count: failed, error: firstError })}`)
    } else {
      toast.success(okMsg)
    }
    setSelected(new Set())
    router.refresh()
  }

  return (
    <div className="space-y-3">
      {bulk && visibleSelected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 dark:border-teal-900/50 dark:bg-teal-950/40">
          <span className="text-sm font-medium text-teal-800 dark:text-teal-300">
            {t('bulk.selected', { count: visibleSelected.size })}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => runBulk('approved')}>
              {t('bulk.approveSelected')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => runBulk('rejected')}>
              {t('bulk.rejectSelected')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(new Set())}>
              {tc('actions.clear')}
            </Button>
          </span>
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            {bulk ? (
              <TableHead className="w-10">
                <input
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected
                  }}
                  type="checkbox"
                  className="h-4 w-4 accent-teal-600"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={t('bulk.selectAll')}
                />
              </TableHead>
            ) : null}
            <TableHead>{t('table.document')}</TableHead>
            <TableHead>{t('table.kind')}</TableHead>
            <TableHead>{tc('labels.party')}</TableHead>
            <TableHead className="text-right">{tc('labels.amount')}</TableHead>
            <TableHead>{t('table.approval')}</TableHead>
            <TableHead>{t('table.requested')}</TableHead>
            {showAssignee ? <TableHead>{t('table.assignee')}</TableHead> : null}
            {actionsEnabled ? <TableHead>{t('table.decision')}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              {bulk ? (
                <TableCell>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-teal-600"
                    checked={visibleSelected.has(r.key)}
                    onChange={() => toggle(r.key)}
                    aria-label={t('bulk.selectRow', { document: r.documentNumber })}
                  />
                </TableCell>
              ) : null}
              <TableCell className="font-mono text-[13px] font-semibold">
                {r.href ? (
                  <Link
                    href={r.href as any}
                    className="text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {r.documentNumber}
                  </Link>
                ) : (
                  r.documentNumber
                )}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{r.kindLabel}</Badge>
              </TableCell>
              <TableCell>{r.party}</TableCell>
              <TableCell className="text-right tabular-nums">{r.amount}</TableCell>
              <TableCell>
                <span className="flex flex-col">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {r.approvalTitle}
                    {r.quorumAll ? (
                      <Badge variant="outline" className="ml-2 align-middle">
                        {t('gates.badges.quorumAll')}
                      </Badge>
                    ) : null}
                    {r.signatureRequired ? (
                      <Badge variant="outline" className="ml-2 align-middle">
                        {t('gates.badges.signature')}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">{r.engineName}</span>
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap text-slate-500 dark:text-slate-400">
                <span className="inline-flex items-baseline gap-2">
                  {r.requestedAt.slice(0, 10)}
                  <Aging
                    requestedAt={r.requestedAt}
                    label={(days) => t('aging.days', { days })}
                  />
                </span>
              </TableCell>
              {showAssignee ? (
                <TableCell className="text-slate-500 dark:text-slate-400">{r.assignee}</TableCell>
              ) : null}
              {actionsEnabled ? (
                <TableCell>
                  <GateActions
                    gateId={r.gateId}
                    canDelegate={r.canDelegate}
                    users={users}
                    signatureRequired={r.signatureRequired}
                  />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
