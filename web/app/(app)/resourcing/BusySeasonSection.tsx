'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { Badge, Button } from '@openbooks/ui'
import { promptDialog } from '../../../lib/prompt'
import { formatTicketHours } from '../../../lib/format'
import type { BusySeasonGap, BusySeasonProject } from '../../../lib/resourcing/busy-season'

/**
 * The cockpit's busy-season panel body: one row per department and week
 * whose claimed load exceeds net capacity, each drilling to its evidence
 * and, where the operator may staff it, offering a confirmed draft-request
 * action.
 *
 * Like the purchasing attention list, the empty case lives here: a component
 * that knows how to render itself with no rows is the ordinary answer. Every
 * string arrives through labels so the spec stays serializable. The only
 * write is a single draft resource-request creation through the landed
 * request route; nothing here assigns, books, or submits.
 */
export interface BusySeasonLabels {
  empty: string
  weekOf: string
  gap: string
  demand: string
  capacity: string
  plan: string
  evidence: string
  staff: string
  assignments: string
  opportunities: string
  absences: string
  holidays: string
  requestAction: string
  noProjects: string
  confirmTitle: string
  projectLabel: string
  confirm: string
  created: string
  requestFailed: string
  reason: string
}

type Refusal = { message: string; remedy?: string }

async function readRefusal(response: Response, fallback: string): Promise<Refusal> {
  const body = await response.json().catch(() => null) as {
    message?: string
    remedy?: string
    error?: string
  } | null
  return {
    message: body?.message ?? body?.error ?? fallback,
    remedy: body?.remedy,
  }
}

function fill(template: string, values: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value)
  }
  return out
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8)
}

function EvidenceLinks({
  gap,
  labels,
}: {
  gap: BusySeasonGap
  labels: BusySeasonLabels
}) {
  const evidence = gap.evidence
  return (
    <div className="mt-1 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
      {evidence.demandLineIds.length > 0 ? (
        <p>
          {labels.demand} ({evidence.demandLineIds.length}):{' '}
          {evidence.demandLineIds.map((id) => (
            <Link
              key={id}
              href={`/resourcing/demand?demand=${id}` as never}
              title={id}
              className="mr-1.5 underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
            >
              {shortId(id)}
            </Link>
          ))}
        </p>
      ) : null}
      {evidence.opportunityIds.length > 0 ? (
        <p>
          {labels.opportunities} ({evidence.opportunityIds.length}):{' '}
          {evidence.opportunityIds.map((id) => (
            <Link
              key={id}
              href={`/crm/opportunities?opportunity=${id}` as never}
              title={id}
              className="mr-1.5 underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
            >
              {shortId(id)}
            </Link>
          ))}
        </p>
      ) : null}
      {evidence.assignmentIds.length > 0 ? (
        <p>
          {labels.assignments} ({evidence.assignmentIds.length}):{' '}
          {evidence.assignmentIds.map((id) => (
            <Link
              key={id}
              href={`/resourcing/assignments?assignment=${id}` as never}
              title={id}
              className="mr-1.5 underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
            >
              {shortId(id)}
            </Link>
          ))}
        </p>
      ) : null}
      {evidence.capacityPersonIds.length > 0 ? (
        <p>
          {labels.staff} ({evidence.capacityPersonIds.length}):{' '}
          {evidence.capacityPersonIds.map((id) => (
            <Link
              key={id}
              href={`/entities/employees?party=${id}` as never}
              title={id}
              className="mr-1.5 underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
            >
              {shortId(id)}
            </Link>
          ))}
        </p>
      ) : null}
      {evidence.absenceRowIds.length > 0 ? (
        <p>
          {labels.absences} (
          <Link href="/hrm/leave" className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300">
            {evidence.absenceRowIds.length}
          </Link>
          )
        </p>
      ) : null}
      {evidence.holidayDates.length > 0 ? (
        <p>
          {labels.holidays} (
          <Link
            href="/admin/setup/payroll?tab=holidays"
            className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
          >
            {evidence.holidayDates.length}
          </Link>
          )
        </p>
      ) : null}
    </div>
  )
}

function GapRow({
  gap,
  projects,
  labels,
  canCreateDraft,
}: {
  gap: BusySeasonGap
  projects: BusySeasonProject[]
  labels: BusySeasonLabels
  canCreateDraft: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  // One key per row, kept until the draft exists: a retry after a refusal
  // resumes the same creation instead of minting a duplicate.
  const idempotencyKey = useRef<string | null>(null)

  async function createDraftRequest() {
    if (busy) return
    const projectId = await promptDialog({
      title: fill(labels.confirmTitle, { department: gap.departmentName, week: gap.weekStart }),
      label: labels.projectLabel,
      confirmLabel: labels.confirm,
      options: projects.map((project) => ({ value: project.id, label: project.name })),
    })
    if (!projectId) return
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID()
    setBusy(true)
    setRefusal(null)
    try {
      const response = await fetch('/api/resourcing/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey.current,
        },
        body: JSON.stringify({
          projectId,
          jobTitle: gap.suggestedJobTitle,
          firstWeek: gap.weekStart,
          lastWeek: gap.weekStart,
          hoursPerWeek: gap.gapHours,
          reason: fill(labels.reason, {
            department: gap.departmentName,
            week: gap.weekStart,
            gap: formatTicketHours(gap.gapHours),
            demand: formatTicketHours(gap.demandHours),
            capacity: formatTicketHours(gap.capacityHours),
            plan: formatTicketHours(gap.planHours),
          }),
        }),
      })
      if (!response.ok) {
        setRefusal(await readRefusal(response, labels.requestFailed))
        return
      }
      const result = await response.json() as { id?: unknown }
      if (typeof result.id !== 'string' || !result.id) {
        setRefusal({ message: labels.requestFailed })
        return
      }
      setCreatedId(result.id)
    } catch {
      setRefusal({ message: labels.requestFailed })
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {gap.departmentName} · {labels.weekOf} {gap.weekStart}
          </p>
          <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">
            {labels.gap} {formatTicketHours(gap.gapHours)} h · {labels.demand} {formatTicketHours(gap.demandHours)} h ·{' '}
            {labels.plan} {formatTicketHours(gap.planHours)} h · {labels.capacity}{' '}
            {formatTicketHours(gap.capacityHours)} h
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {labels.evidence}: {labels.demand} ×{gap.evidence.demandLineIds.length} · {labels.plan} ×
            {gap.evidence.assignmentIds.length} · {labels.staff} ×{gap.evidence.capacityPersonIds.length}
          </p>
          <EvidenceLinks gap={gap} labels={labels} />
          {refusal ? (
            <p className="mt-1.5 text-xs text-red-600 dark:text-red-400" role="alert">
              {refusal.message}
              {refusal.remedy ? ` ${refusal.remedy}` : null}
            </p>
          ) : null}
          {createdId ? (
            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">
              {labels.created}{' '}
              <Link
                href={`/resourcing/requests?request=${createdId}` as never}
                className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300"
              >
                {createdId}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge variant="warning">
            {labels.gap} {formatTicketHours(gap.gapHours)} h
          </Badge>
          {canCreateDraft && !createdId ? (
            projects.length > 0 ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void createDraftRequest()}>
                {labels.requestAction}
              </Button>
            ) : (
              <span className="max-w-44 text-right text-xs text-slate-500 dark:text-slate-400">{labels.noProjects}</span>
            )
          ) : null}
        </div>
      </div>
    </li>
  )
}

export function BusySeasonSection({
  gaps,
  projects,
  labels,
  canCreateDraft,
}: {
  gaps: BusySeasonGap[]
  projects: BusySeasonProject[]
  labels: BusySeasonLabels
  canCreateDraft: boolean
}) {
  if (gaps.length === 0) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-sm text-slate-400 dark:text-slate-500">{labels.empty}</p>
      </div>
    )
  }
  return (
    <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
      {gaps.map((gap) => (
        <GapRow
          key={`${gap.departmentId} ${gap.weekStart}`}
          gap={gap}
          projects={projects}
          labels={labels}
          canCreateDraft={canCreateDraft}
        />
      ))}
    </ul>
  )
}
