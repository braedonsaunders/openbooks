'use client'

import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Crosshair, GitBranch, Maximize2, Pencil, Users } from 'lucide-react'
import { Button, Select, UrlDrawer } from '@openbooks/ui'
import type { OrgChartNode } from '@openbooks/engine/hrm/org-chart/contracts'
import type { loadOrgChartHome } from '../../../../lib/hrm/org-chart-home'
import { OrgChartCanvas } from './OrgChartCanvas'
import { OrgChartEditor, type ChartEditRequest } from './OrgChartEditor'
import { departmentColor, flattenChart, matchesNode, nodeKey } from './graph'

type Home = NonNullable<Awaited<ReturnType<typeof loadOrgChartHome>>>
type EditingProps = { canManage?: boolean; today?: string; departmentOptions?: Home['departmentOptions'] }

export function OrgChartTree({ chart, personBaseHref, labels, canManage = false, today = chart.asOf, departmentOptions = [] }: {
  chart: Home['chart']; personBaseHref: string; labels: Record<string, string>
} & EditingProps) {
  const router = useRouter()
  const params = useSearchParams()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [editRequest, setEditRequest] = useState<ChartEditRequest | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const query = (params.get('q') ?? '').trim().toLocaleLowerCase()
  const department = params.get('department') ?? ''
  const rootId = params.get('root') ?? ''
  const flat = useMemo(() => flattenChart(chart.roots), [chart])
  const focused = flat.find((node) => node.employmentId === rootId)
  const roots = useMemo(() => focused ? [focused] : chart.roots, [focused, chart.roots])
  const departments = useMemo(() => [...new Set(flat.map((node) => node.department).filter((value): value is string => Boolean(value)))].sort(), [flat])
  const matches = useMemo(() => flattenChart(roots).filter((node) => matchesNode(node, query, department)), [roots, query, department])

  const navigate = useCallback((changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString())
    next.delete('person')
    next.delete('page')
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    router.push(`/hrm/org-chart?${next}`, { scroll: false })
  }, [params, router])
  const open = useCallback((node: OrgChartNode) => {
    if (!node.employmentId) return
    const next = new URLSearchParams(personBaseHref.split('?')[1])
    next.set('person', node.employmentId)
    router.push(`/hrm/org-chart?${next}`, { scroll: false })
  }, [personBaseHref, router])
  const edit = useCallback((node: OrgChartNode, managerId?: string) => {
    if (!canManage || !node.employmentId) return
    setRefusal(null)
    setEditRequest({ employmentId: node.employmentId, ...(managerId ? { managerId } : {}) })
  }, [canManage])
  const focus = useCallback((node: OrgChartNode) => navigate({ root: node.employmentId, q: null, department: null }), [navigate])
  const toggle = useCallback((id: string) => setCollapsed((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  if (!chart.roots.length) return <p className="py-16 text-center text-sm text-slate-500 dark:text-slate-400">{labels.empty}</p>
  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1.5"><Users size={15} /><strong className="text-slate-900 dark:text-slate-100">{chart.headcount}</strong>{labels.headcount}</span>
        <span><strong className="text-slate-900 dark:text-slate-100">{chart.vacancies}</strong> {labels.vacancies}</span>
        <span><strong className="text-slate-900 dark:text-slate-100">{chart.layers}</strong> {labels.layers}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={labels.department} value={department} onChange={(event) => navigate({ department: event.target.value })} className="!w-auto !text-xs">
          <option value="">{labels.allDepartments}</option>
          {department && !departments.includes(department) && <option value={department}>{department}</option>}
          {departments.map((name) => <option key={name} value={name}>{name}</option>)}
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}><Maximize2 size={14} />{labels.expandAll}</Button>
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(flat.filter((node) => node.children.length).map(nodeKey)))}><GitBranch size={14} />{labels.collapseAll}</Button>
        {canManage && <Button size="sm" variant={editing ? 'default' : 'outline'} aria-pressed={editing} onClick={() => setEditing((value) => !value)}><Pencil size={14} />{editing ? labels.doneEditing : labels.editStructure}</Button>}
      </div>
    </div>
    {(focused || rootId || editing || query || department) && <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-teal-50/50 px-4 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-teal-950/20 dark:text-slate-300">
      {rootId && <><Crosshair size={14} /><span>{focused ? `${labels.focus}: ${focused.name}` : labels.missingFocus}</span><Button size="sm" variant="ghost" onClick={() => navigate({ root: null })}>{labels.wholeOrganization}</Button></>}
      {editing && <span>{labels.approvalHint}</span>}
      {(query || department) && <><span role="status">{matches.length} {labels.matches}</span><Button size="sm" variant="ghost" onClick={() => navigate({ q: null, department: null })}>{labels.clearFilters}</Button></>}
    </div>}
    {refusal && <p role="alert" className="px-4 py-2 text-sm text-red-600">{refusal}</p>}
    {editRequest && canManage && <OrgChartEditor key={`${editRequest.employmentId}:${editRequest.managerId ?? ''}`} request={editRequest} today={today} departmentOptions={departmentOptions} labels={labels} onClose={() => setEditRequest(null)} />}
    {query && matches.length > 0 && <div className="flex shrink-0 flex-wrap gap-2 border-b bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
      {matches.slice(0, 8).filter((node) => node.employmentId).map((node) => <Button key={nodeKey(node)} size="sm" variant="outline" onClick={() => focus(node)}><Crosshair size={12} />{node.name}</Button>)}
    </div>}
    <OrgChartCanvas roots={roots} allRoots={chart.roots} collapsed={collapsed} query={query} department={department} editing={editing} canManage={canManage} labels={labels}
      onOpen={open} onEdit={edit} onFocus={focus} onToggle={toggle} onRefusal={setRefusal} />
  </div>
}

export function OrgChartPerson({ selected, manager, closeHref, labels, canManage = false, today = '', departmentOptions = [] }: {
  selected: Home['selected']; manager?: Home['selected']; closeHref: string; labels: Record<string, string>
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
        {selected.partyId && <Link href={`/entities/employees?party=${encodeURIComponent(selected.partyId)}&partyTab=employment`} className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">{labels.openEmployee}</Link>}
        {canManage && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil size={14} />{labels.edit}</Button>}
      </div>
      {canManage && <p className="text-xs text-slate-500">{labels.approvalHint}</p>}
      {editing && canManage && selected.employmentId && <OrgChartEditor stacked request={{ employmentId: selected.employmentId }} today={today} departmentOptions={departmentOptions} labels={labels} onClose={() => setEditing(false)} />}
    </div>
  </UrlDrawer>
}
