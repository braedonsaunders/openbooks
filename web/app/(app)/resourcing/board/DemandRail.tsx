'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { MoreHorizontal } from 'lucide-react'
import { Badge, Button, ContextMenu, useContextMenu } from '@openbooks/ui'
import { formatTicketHours } from '../../../../lib/format'
import { sum } from '@openbooks/engine/src/money/money.ts'
import type { GenericDemandWeek } from '@openbooks/engine/src/resourcing/forecast.ts'
import type { DemandWeek } from '../../../../lib/resourcing/demand'
import type { ResourcingBoard } from '../../../../lib/resourcing/queries'

type Assignment = ResourcingBoard['rows'][number]
type Labels = Record<string, string> & {
  demandTitle: string
  hard: string
  soft: string
  generic: string
  release: string
}

export function DemandRail({
  genericDemand,
  assignments,
  demand,
  canManage,
  labels,
  projectNames,
}: {
  genericDemand: GenericDemandWeek[]
  assignments: Assignment[]
  demand: DemandWeek[]
  canManage: boolean
  labels: Labels
  projectNames: Record<string, string>
}) {
  const t = useTranslations('resourcing')
  const router = useRouter()
  const menu = useContextMenu()
  const [selected, setSelected] = useState<Assignment | null>(null)
  const [refusal, setRefusal] = useState<{ message: string; remedy?: string } | null>(null)
  const assignmentsById = useMemo(() => new Map(assignments.map((assignment) => [assignment.id, assignment])), [assignments])
  const roleDemand = useMemo(() => {
    const groups = new Map<string, { week: string; title: string; basis: 'manual' | 'pipeline'; hours: string[] }>()
    for (const line of demand) {
      if (line.basis !== 'manual' && line.basis !== 'pipeline') continue
      const key = `${line.weekStart}:${line.jobTitle}:${line.basis}`
      const group = groups.get(key) ?? { week: line.weekStart, title: line.jobTitle, basis: line.basis, hours: [] }
      group.hours.push(line.weightedHours)
      groups.set(key, group)
    }
    return [...groups.values()].map((group) => ({ ...group, hours: sum(group.hours) }))
      .sort((a, b) => a.week.localeCompare(b.week) || a.title.localeCompare(b.title) || a.basis.localeCompare(b.basis))
  }, [demand])
  const excluded = useMemo(() => {
    const groups = new Map<string, { week: string; reason: NonNullable<DemandWeek['excludedReason']>; ids: Set<string> }>()
    for (const line of demand) {
      if (!line.excludedReason) continue
      const key = `${line.weekStart}:${line.excludedReason}`
      const group = groups.get(key) ?? { week: line.weekStart, reason: line.excludedReason, ids: new Set<string>() }
      group.ids.add(line.lineId)
      groups.set(key, group)
    }
    return [...groups.values()].sort((a, b) => a.week.localeCompare(b.week) || a.reason.localeCompare(b.reason))
  }, [demand])
  const menuItems = selected && canManage ? [{
    key: 'release',
    label: labels.release,
    danger: true,
    onSelect: () => { void release(selected) },
  }] : []

  async function release(assignment: Assignment) {
    setRefusal(null)
    try {
      const response = await fetch(`/api/resourcing/assignments/${assignment.id}/release`, { method: 'POST' })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string; remedy?: string; error?: string } | null
        setRefusal({ message: body?.message ?? body?.error ?? t('assignments.actionFailed'), remedy: body?.remedy })
        return
      }
      router.refresh()
    } catch {
      setRefusal({ message: t('assignments.actionFailed') })
    }
  }

  return (
    <aside className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-4 text-base font-semibold text-slate-900 dark:text-slate-100">{labels.demandTitle}</h2>
      {refusal ? <div role="alert" className="mb-3 rounded-md border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100"><p>{refusal.message}</p>{refusal.remedy ? <p>{refusal.remedy}</p> : null}</div> : null}
      <div className="space-y-5">
        {genericDemand.map((generic) => {
          const bookingRows = generic.assignmentIds.flatMap((id) => {
            const assignment = assignmentsById.get(id)
            return assignment ? [assignment] : []
          })
          return (
            <section key={`${generic.jobTitle}:${generic.weekStart}`} className="space-y-2 border-b border-slate-200 pb-4 last:border-0 dark:border-slate-800">
              <div className="flex items-start justify-between gap-2">
                <div><h3 className="text-sm font-medium text-slate-800 dark:text-slate-100">{generic.jobTitle}</h3><p className="text-xs text-slate-500 dark:text-slate-400">{generic.weekStart}</p></div>
                <Badge variant="secondary">{labels.generic}</Badge>
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs"><Badge variant="secondary">{labels.hard} {formatTicketHours(generic.hardHours)} h</Badge><Badge variant="outline">{labels.soft} {formatTicketHours(generic.softHours)} h</Badge></div>
              {bookingRows.map((assignment) => (
                <div
                  key={assignment.id}
                  draggable={canManage}
                  onDragStart={(event) => event.dataTransfer.setData('application/x-openbooks-resourcing-assignment', JSON.stringify({ projectId: assignment.projectId, plannedHours: assignment.plannedHours, weekStart: assignment.weekStart }))}
                  className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/70"
                >
                  <span>{formatTicketHours(assignment.plannedHours)} h · {assignment.booking} · {projectNames[assignment.projectId] ?? assignment.projectId}</span>
                  {canManage ? <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0"
                    aria-label={`${labels.release}: ${generic.jobTitle}, ${generic.weekStart}`}
                    onClick={(event) => { setSelected(assignment); menu.openBelow(event.currentTarget) }}
                  ><MoreHorizontal size={16} aria-hidden /></Button> : null}
                </div>
              ))}
            </section>
          )
        })}
        {roleDemand.map((item) => (
          <section key={`${item.week}:${item.title}:${item.basis}`} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
            <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.title}</h3><p className="text-xs text-slate-500 dark:text-slate-400">{item.week}</p></div><Badge variant={item.basis === 'pipeline' ? 'warning' : 'outline'}>{t(`demand.basis.${item.basis}`)}</Badge></div>
            <p className="mt-2 text-sm tabular-nums">{formatTicketHours(item.hours)} h</p>
          </section>
        ))}
        {excluded.map((item) => (
          <section key={`${item.week}:${item.reason}`} className="rounded-md border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-900 dark:bg-amber-950/20">
            <div className="flex items-start justify-between gap-2"><p className="text-xs font-medium text-amber-950 dark:text-amber-100">{item.week} · {t(`demand.exclusion.${item.reason}`)}</p><Badge variant="warning">{item.ids.size}</Badge></div>
          </section>
        ))}
      </div>
      {!genericDemand.length && !roleDemand.length && !excluded.length ? <p className="text-sm text-slate-500 dark:text-slate-400">{t('board.noDemand')}</p> : null}
      <ContextMenu open={menu.open} position={menu.position} onClose={menu.close} items={menuItems} />
    </aside>
  )
}
