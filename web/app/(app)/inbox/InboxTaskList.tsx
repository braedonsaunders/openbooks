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
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
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
  labels: { open: string; acted: string; delegatePlaceholder: string }
}) {
  // `refused` carries an ICU argument, so it is resolved HERE, where the
  // argument exists. Resolved in the loader it threw FORMATTING_ERROR and
  // next-intl handed back the key path — and the client then ran
  // `.replace('{message}', …)` over a string with no placeholder in it, so
  // every refusal this list can raise reached the operator as the literal
  // text `inbox.refused`. The service's message was computed, correct, and
  // dropped on the way out.
  const t = useTranslations('inbox')
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
        toast.error(t('refused', { message: data.error ?? actionKey }))
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.task')}</TableHead>
          <TableHead>{t('columns.detail')}</TableHead>
          <TableHead>{t('columns.kind')}</TableHead>
          <TableHead>{t('columns.due')}</TableHead>
          <TableHead>{t('columns.priority')}</TableHead>
          <TableHead>{t('columns.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Link href={row.href as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                {row.title}
              </Link>
            </TableCell>
            <TableCell className="max-w-md text-slate-500 dark:text-slate-400">
              <span className="line-clamp-2">{row.subtitle ?? '—'}</span>
            </TableCell>
            <TableCell><Badge variant="secondary">{row.kindLabel}</Badge></TableCell>
            <TableCell className="tabular-nums text-slate-500 dark:text-slate-400">{row.dueLabel ?? '—'}</TableCell>
            <TableCell>
              {row.priorityLabel ? (
                <Badge variant={row.priorityTone === 'slate' ? 'outline' : row.priorityTone === 'amber' ? 'warning' : 'destructive'}>
                  {row.priorityLabel}
                </Badge>
              ) : '—'}
            </TableCell>
            <TableCell>
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
                {delegating === row.id ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-44">
                      <Select
                        disabled={busy !== null}
                        defaultValue=""
                        onChange={(e) => runDelegate(row, e.target.value)}
                      >
                        <option value="">{labels.delegatePlaceholder}</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </Select>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setDelegating(null)}>×</Button>
                  </span>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
