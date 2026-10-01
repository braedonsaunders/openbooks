'use client'

import type { OrgChartLabels } from './graph'

import Link from 'next/link'
import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button, UrlDrawer } from '@openbooks/ui'
import type { loadOrgChartHome } from '../../../../lib/hrm/org-chart-home'
import { OrgChartEditor } from './OrgChartEditor'
import { departmentColor, nodeKey } from './graph'

type Home = NonNullable<Awaited<ReturnType<typeof loadOrgChartHome>>>
type EditingProps = { canReadEmployee?: boolean; canManage?: boolean; today?: string; departmentOptions?: Home['departmentOptions'] }

export { ManualOrgChart as OrgChartTree } from './ManualOrgChart'

export function OrgChartPerson({ selected, manager, closeHref, labels, canReadEmployee = false, canManage = false, today = '', departmentOptions = [] }: {
  selected: Home['selected']; manager?: Home['selected']; closeHref: string; labels: OrgChartLabels
} & EditingProps) {
  const [editing, setEditing] = useState(false)
  if (!selected) return null
  const color = departmentColor(selected.department)
  const personHref = (id: string) => `${closeHref}&person=${encodeURIComponent(id)}`
  return <UrlDrawer open closeHref={closeHref} title={selected.name} description={selected.title ?? undefined}>
    <div className="space-y-6">
      <div className="flex items-center gap-4 rounded-xl bg-slate-50 p-4 dark:bg-slate-800/50">
        <div aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold" style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>{selected.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('')}</div>
        <div><p className="font-medium">{selected.title ?? '—'}</p><p className="mt-1 text-sm text-slate-500">{selected.department ?? labels.noDepartment}</p></div>
      </div>
      <section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{labels.manager}</h3>
        {manager?.employmentId ? <Link className="text-sm text-teal-700 hover:underline dark:text-teal-300" href={personHref(manager.employmentId)}>{manager.name}<span className="ml-2 text-slate-500">{manager.title}</span></Link> : <p className="text-sm text-slate-500">{labels.noVisibleManager}</p>}
      </section>
      <section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{labels.reports} · {selected.spanOfControl}</h3>
        {selected.children.length ? <ul className="divide-y dark:divide-slate-800">{selected.children.map((child) => <li key={nodeKey(child)} className="py-3 text-sm">{child.employmentId ? <Link href={personHref(child.employmentId)} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{child.name}</Link> : labels.vacant}<p className="mt-1 text-xs text-slate-500">{child.title}</p></li>)}</ul> : <p className="text-sm text-slate-500">{labels.noReports}</p>}
      </section>
      <div className="flex flex-wrap gap-2">
        {canReadEmployee && selected.partyId && <Link href={`/entities/employees?party=${encodeURIComponent(selected.partyId)}&partyTab=employment`} className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">{labels.openEmployee}</Link>}
        {canManage && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil size={14} />{labels.edit}</Button>}
      </div>
      {canManage && <p className="text-xs text-slate-500">{labels.approvalHint}</p>}
      {editing && canManage && selected.employmentId && <OrgChartEditor key={selected.employmentId} stacked request={{ employmentId: selected.employmentId }} today={today} departmentOptions={departmentOptions} labels={labels} onClose={() => setEditing(false)} />}
    </div>
  </UrlDrawer>
}
