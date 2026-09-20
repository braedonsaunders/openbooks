'use client'

// HR-15 inbox task rows: the non-decision inbox items (checklist steps,
// own drafts, reviews, enrollment windows, qualifications, signatures,
// timesheet weeks, notices) with row actions that complete in place.
//
// Decision items (flow gates, documents, pay runs, budgets) keep rendering
// through ApprovalsTable + GateActions — this list only ever carries the
// new kinds, so the two can never show the same work twice. Every action
// posts to /api/inbox/act, which delegates to the source's native service;
// a refusal toasts the service's message intact and the row stays.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Select } from '@openbooks/ui'
import { promptDialog } from '../../../lib/prompt'

export interface InboxTaskAction {
  key: string
  label: string
  style: 'primary' | 'secondary' | 'danger'
  needsReason: boolean
}

export interface InboxTaskRow {
  id: string
  kindLabel: string
  title: string
  subtitle: string | null
  dueLabel: string | null
  priorityLabel: string | null
  priorityTone: 'rose' | 'amber' | 'slate'
  href: string
  actions: InboxTaskAction[]
}

function actionVariant(style: InboxTaskAction['style']): 'default' | 'outline' | 'destructive' {
  if (style === 'danger') return 'destructive'
  if (style === 'secondary') return 'outline'
  return 'default'
}

export function InboxTaskList({
  rows,
  users,
  labels,
}: {
  rows: InboxTaskRow[]
  users: { id: string; name: string }[]
  labels: { open: string; acted: string; refused: string; delegatePlaceholder: string }
}) {
  const router = useRouter()
  const [done, setDone] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [delegating, setDelegating] = useState<string | null>(null)

  async function post(itemId: string, actionKey: string, reason?: string) {
    setBusy(`${itemId}:${actionKey}`)
    try {
      const res = await fetch('/api/inbox/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, actionKey, ...(reason ? { reason } : {}) }),
      })
      if (!res.ok) {
        // Error bodies are checked before they are parsed: a refusal is a
        // message for the operator, never a parse error.
        const data = await res.json().catch(() => ({}))
        toast.error(labels.refused.replace('{message}', data.error ?? actionKey))
        return
      }
      setDone((prev) => new Set(prev).add(itemId))
      toast.success(labels.acted)
      router.refresh()
    } finally {
      setBusy(null)
      setDelegating(null)
    }
  }

  async function run(row: InboxTaskRow, action: InboxTaskAction) {
    if (action.key === 'delegate') {
      setDelegating(row.id)
      return
    }
    let reason: string | undefined
    if (action.needsReason) {
      const answer = await promptDialog({
        title: action.label,
        label: action.label,
        confirmLabel: action.label,
      })
      if (!answer) return
      reason = answer
    }
    await post(row.id, action.key, reason)
  }

  async function runDelegate(row: InboxTaskRow, toUserId: string) {
    if (!toUserId) return
    const note = await promptDialog({
      title: row.actions.find((a) => a.key === 'delegate')?.label ?? 'Delegate',
      label: labels.delegatePlaceholder,
      confirmLabel: labels.delegatePlaceholder,
    })
    if (note === null) {
      setDelegating(null)
      return
    }
    await post(row.id, 'delegate', `user:${toUserId}: ${note ?? ''}`)
  }

  const visible = rows.filter((row) => !done.has(row.id))
  if (visible.length === 0) return null

  return (
    <ul className="space-y-2">
      {visible.map((row) => (
        <li
          key={row.id}
          className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:gap-3 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{row.kindLabel}</Badge>
              {row.priorityLabel ? (
                <Badge variant={row.priorityTone === 'slate' ? 'outline' : row.priorityTone === 'amber' ? 'warning' : 'destructive'}>
                  {row.priorityLabel}
                </Badge>
              ) : null}
              {row.dueLabel ? (
                <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{row.dueLabel}</span>
              ) : null}
            </div>
            <Link href={row.href as never} className="mt-1 block truncate text-sm font-medium text-slate-900 hover:underline dark:text-slate-100">
              {row.title}
            </Link>
            {row.subtitle ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{row.subtitle}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {row.actions.map((action) => (
              <Button
                key={action.key}
                size="sm"
                variant={actionVariant(action.style)}
                disabled={busy !== null}
                onClick={() => run(row, action)}
              >
                {action.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" asChild>
              <Link href={row.href as never}>{labels.open}</Link>
            </Button>
          </div>
          {delegating === row.id ? (
            <div className="flex items-center gap-1.5">
              <span className="w-44">
                <Select
                  disabled={busy !== null}
                  defaultValue=""
                  onChange={(e) => runDelegate(row, e.target.value)}
                >
                  <option value="">{labels.delegatePlaceholder}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setDelegating(null)}>
                ×
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
