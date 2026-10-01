'use client'

import type { OrgChartLabels } from './graph'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Building2, GitBranch, GripVertical, Plus, Save, Search, UserRound, Users } from 'lucide-react'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import type { Edge } from '@xyflow/react'
import type { OrgChart, OrgChartNode } from '@openbooks/engine/hrm/org-chart/contracts'
import { EMPTY_ORG_CHART_LAYOUT, orgChartLayoutSchema, type OrgChartLayout, type OrgChartLayoutNode, type SavedOrgChartLayout } from '@openbooks/engine/hrm/org-chart/contracts'
import { Pagination } from '../../../../components/pagination'
import { confirmDialog } from '../../../../lib/confirm'
import { useUnsavedNavigationGuard } from '../../../../lib/use-unsaved-navigation-guard'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { OrgChartCanvas, type ChartFlowInstance } from './OrgChartCanvas'
import { OrgChartEditor, type ChartEditRequest } from './OrgChartEditor'
import { canConnectManager, chartEdges, departmentColor, flattenChart, matchesNode } from './graph'

export interface ManualChartProps {
  chart: OrgChart
  layout?: SavedOrgChartLayout
  personBaseHref: string
  labels: OrgChartLabels
  canManage?: boolean
  canEditLayout?: boolean
  today?: string
  departmentOptions?: { value: string; label: string }[]
}

export function ManualOrgChart({ chart, layout = EMPTY_ORG_CHART_LAYOUT, personBaseHref, labels, canManage = false, canEditLayout = false, today = chart.asOf, departmentOptions = [] }: ManualChartProps) {
  const router = useRouter()
  const params = useSearchParams()
  const [graph, setGraph] = useState<OrgChartLayout>(() => structuredClone(layout.graph))
  const [revision, setRevision] = useState(layout.revision)
  const [savedText, setSavedText] = useState(JSON.stringify(layout.graph))
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [sidebarQuery, setSidebarQuery] = useState('')
  const [department, setDepartment] = useState('')
  const [sidebarPage, setSidebarPage] = useState(1)
  const [showPalette, setShowPalette] = useState(false)
  const [editRequest, setEditRequest] = useState<ChartEditRequest | null>(null)
  const [placeholder, setPlaceholder] = useState<OrgChartLayoutNode | null>(null)
  const [placeholderName, setPlaceholderName] = useState('')
  const [placeholderNote, setPlaceholderNote] = useState('')
  const flow = useRef<ChartFlowInstance | null>(null)
  const dirty = JSON.stringify(graph) !== savedText
  const query = (params.get('q') ?? '').trim().toLocaleLowerCase()
  const flat = useMemo(() => flattenChart(chart.roots), [chart])
  const people = useMemo(() => new Map(flat.map((node) => [node.vacant ? `vacancy:${node.positionId}` : `employee:${node.employmentId}`, node])), [flat])
  const edges = useMemo(() => chartEdges(graph, chart.roots), [graph, chart.roots])
  const placed = useMemo(() => new Set(graph.nodes.map((node) => `${node.kind}:${node.referenceId}`)), [graph.nodes])
  const palettePeople = flat.filter((node) => matchesNode(node, sidebarQuery.toLocaleLowerCase(), department))
  const departments = [...new Set(flat.map((node) => node.department).filter((value): value is string => Boolean(value)))].sort()

  useUnsavedNavigationGuard(dirty, labels.discardLayout, labels.discard)

  const updateGraph = useCallback((next: OrgChartLayout) => {
    if (!canEditLayout || savingRef.current) return
    const parsed = orgChartLayoutSchema.safeParse(next)
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => issue.message).join(' ')); return }
    setGraph(parsed.data)
    setError(null)
    setNotice(null)
  }, [canEditLayout])
  const open = useCallback((node: OrgChartNode) => {
    if (!node.employmentId) return
    const next = new URLSearchParams(personBaseHref.split('?')[1])
    next.set('person', node.employmentId)
    router.push(`/hrm/org-chart?${next}`, { scroll: false })
  }, [personBaseHref, router])
  const edit = useCallback((node: OrgChartNode) => {
    if (canManage && node.employmentId) setEditRequest({ employmentId: node.employmentId })
  }, [canManage])
  const toggle = useCallback((id: string) => setCollapsed((prior) => {
    const next = new Set(prior)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  const editPlaceholder = useCallback((node: OrgChartLayoutNode) => {
    if (!canEditLayout) return
    setShowPalette(false)
    setPlaceholder(node); setPlaceholderName(node.label ?? ''); setPlaceholderNote(node.note ?? '')
  }, [canEditLayout])
  const remove = useCallback((id: string) => {
    if (!canEditLayout) return
    updateGraph({ nodes: graph.nodes.filter((node) => node.id !== id), edges: graph.edges.filter((edge) => edge.source !== id && edge.target !== id) })
    setFocusId(null)
  }, [canEditLayout, graph, updateGraph])

  function nextPosition() {
    const center = flow.current?.screenToFlowPosition({ x: window.innerWidth * 0.6, y: window.innerHeight * 0.5 }) ?? { x: 0, y: 0 }
    let point = center
    while (graph.nodes.some(node => Math.abs(node.position.x - point.x) < 270 && Math.abs(node.position.y - point.y) < 190)) point = { x: point.x + 280, y: point.y }
    void flow.current?.setCenter(point.x + 122, point.y + 82, { zoom: flow.current.getZoom(), duration: 200 })
    return point
  }
  function addPerson(person: OrgChartNode, position?: { x: number; y: number }) {
    if (!canEditLayout) return
    const kind = person.vacant ? 'vacancy' : 'employee'
    const referenceId = (person.employmentId ?? person.positionId)!
    if (placed.has(`${kind}:${referenceId}`)) return
    const point = position ?? nextPosition()
    updateGraph({ ...graph, nodes: [...graph.nodes, { id: crypto.randomUUID(), kind, referenceId, position: point }] })
    setShowPalette(false)
  }
  function addPlaceholder(kind: 'department' | 'team' | 'role') {
    const point = nextPosition()
    editPlaceholder({ id: crypto.randomUUID(), kind, label: '', position: point })
  }
  function savePlaceholder() {
    if (!placeholder || !placeholderName.trim()) return
    const node = { ...placeholder, label: placeholderName.trim(), note: placeholderNote.trim() }
    const next = graph.nodes.some((item) => item.id === node.id) ? graph.nodes.map((item) => item.id === node.id ? node : item) : [...graph.nodes, node]
    updateGraph({ ...graph, nodes: next })
    setPlaceholder(null)
  }
  async function closePlaceholder() {
    if ((placeholderName !== (placeholder?.label ?? '') || placeholderNote !== (placeholder?.note ?? '')) && !await confirmDialog(labels.discardPlaceholder)) return
    setPlaceholder(null)
  }
  async function connect(sourceId: string, targetId: string, oldEdge?: Edge) {
    if (savingRef.current) return
    const source = graph.nodes.find((node) => node.id === sourceId)
    const target = graph.nodes.find((node) => node.id === targetId)
    if (!source || !target) return
    if (oldEdge?.data?.canonical && target.id !== oldEdge.target) { setError(labels.reconnectHint); return }
    if (source.kind === 'employee' && target.kind === 'employee') {
      if (!canManage || !source.referenceId || !target.referenceId) return
      if (!canConnectManager(chart.roots, source.referenceId, target.referenceId)) { setError(labels.invalidConnection); return }
      const manager = people.get(`employee:${source.referenceId}`)
      const employee = people.get(`employee:${target.referenceId}`)
      if (!manager || !employee) { setError(labels.unavailableHint); return }
      const current = flat.find((node) => node.children.some((child) => child.employmentId === target.referenceId))
      const message = labels.managerChangeConfirm.replace('{employee}', employee.name).replace('{current}', current?.name ?? labels.noVisibleManager).replace('{manager}', manager.name)
      if (!await confirmDialog({ title: labels.managerChangeTitle, message, confirmLabel: labels.reviewChange })) return
      setEditRequest({ employmentId: target.referenceId, managerId: source.referenceId })
      return
    }
    if (!canEditLayout) return
    const previous = oldEdge ? graph.edges.filter((edge) => !(edge.source === oldEdge.source && edge.target === oldEdge.target)) : graph.edges
    updateGraph({ ...graph, edges: [...previous, { source: sourceId, target: targetId }] })
  }
  async function deleteEdge(edge: Edge) {
    if (edge.data?.canonical) {
      const target = graph.nodes.find((node) => node.id === edge.target)
      const person = target?.referenceId ? people.get(`employee:${target.referenceId}`) : null
      if (canManage && person && await confirmDialog({ title: labels.managerChangeTitle, message: labels.linkedEdgeHint, confirmLabel: labels.reviewChange })) edit(person)
      return
    }
    if (canEditLayout && await confirmDialog({ message: labels.removeConnectionConfirm, confirmLabel: labels.removeConnection })) updateGraph({ ...graph, edges: graph.edges.filter((item) => !(item.source === edge.source && item.target === edge.target)) })
  }
  async function save() {
    if (!canEditLayout || savingRef.current || !dirty) return
    savingRef.current = true; setSaving(true); setError(null)
    const snapshot = graph
    try {
      const response = await fetch('/api/hrm/org-chart/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph: snapshot, expectedRevision: revision }) })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, labels.saveFailed))
      const body = await response.json() as { layout?: SavedOrgChartLayout }
      if (!body.layout || body.layout.revision !== revision + 1) throw new Error(labels.saveFailed)
      setRevision(body.layout.revision); setSavedText(JSON.stringify(snapshot)); setNotice(labels.saved)
    } catch (failure) { setError(failure instanceof Error ? failure.message : labels.saveFailed) }
    finally { savingRef.current = false; setSaving(false) }
  }

  const visibleIds = useMemo(() => {
    const shown = new Set(graph.nodes.map((node) => node.id))
    const children = new Map<string, string[]>()
    const parents = new Map<string, string[]>()
    for (const edge of edges) {
      children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target])
      parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source])
    }
    const descendants = (id: string, into: Set<string>) => {
      const pending = [...(children.get(id) ?? [])]
      while (pending.length) {
        const next = pending.pop()!
        if (!into.has(next)) { into.add(next); pending.push(...(children.get(next) ?? [])) }
      }
    }
    if (focusId && shown.has(focusId)) {
      const focused = new Set([focusId]); descendants(focusId, focused)
      for (const id of shown) if (!focused.has(id)) shown.delete(id)
    }
    if (query) {
      const matched = new Set(graph.nodes.filter((node) => {
        const person = node.referenceId ? people.get(`${node.kind}:${node.referenceId}`) : null
        return [node.label, node.note, person?.name, person?.title, person?.department].some((value) => value?.toLocaleLowerCase().includes(query))
      }).map((node) => node.id))
      const pending = [...matched]
      while (pending.length) {
        for (const parent of parents.get(pending.pop()!) ?? []) if (!matched.has(parent)) { matched.add(parent); pending.push(parent) }
      }
      for (const id of shown) if (!matched.has(id)) shown.delete(id)
    } else {
      const hidden = new Set<string>()
      collapsed.forEach((id) => descendants(id, hidden))
      for (const id of hidden) shown.delete(id)
    }
    return shown
  }, [graph.nodes, edges, focusId, query, people, collapsed])
  const focus = useCallback((id: string) => { setFocusId(id); setCollapsed(new Set()); void flow.current?.fitView({ nodes: [{ id }], padding: 0.8, maxZoom: 1 }) }, [])
  const init = useCallback((instance: ChartFlowInstance) => { flow.current = instance }, [])

  const palette = <>        <div className="space-y-3 border-b p-4 dark:border-slate-800"><h3 className="flex items-center gap-2 text-sm font-semibold"><Users size={16} className="text-teal-600" />{labels.sidebarTitle}</h3>
          <div className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-3 text-slate-400" /><Input aria-label={labels.sidebarSearch} placeholder={labels.sidebarSearch} value={sidebarQuery} onChange={(event) => { setSidebarQuery(event.target.value); setSidebarPage(1) }} className="!pl-9 !text-xs" /></div>
          <Select aria-label={labels.department} value={department} onChange={(event) => { setDepartment(event.target.value); setSidebarPage(1) }} className="!text-xs"><option value="">{labels.allDepartments}</option>{departments.map((name) => <option key={name}>{name}</option>)}</Select>
          {canEditLayout && <div><p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">{labels.addPlaceholder}</p><div className="grid grid-cols-3 gap-1.5">{(['department', 'team', 'role'] as const).map((kind) => <Button key={kind} size="sm" variant="outline" className="!h-auto !flex-col !gap-1 !px-1 !py-2 !text-[10px]" onClick={() => addPlaceholder(kind)}>{kind === 'role' ? <UserRound size={15} /> : <Building2 size={15} />}{labels[kind]}</Button>)}</div></div>}
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {palettePeople.length === 0 && <p className="py-6 text-center text-xs text-slate-500">{labels.noMatch}</p>}
          {palettePeople.slice((sidebarPage - 1) * 50, sidebarPage * 50).map((person) => {
            const kind = person.vacant ? 'vacancy' : 'employee'
            const ref = (person.employmentId ?? person.positionId)!
            const onChart = placed.has(`${kind}:${ref}`)
            const color = departmentColor(person.department)
            return <div key={`${kind}:${ref}`} draggable={canEditLayout && !onChart} onDragStart={(event) => { event.dataTransfer.setData('application/openbooks-chart-person', `${kind}:${ref}`); event.dataTransfer.effectAllowed = 'copy' }}
              className={`group flex items-center gap-2 rounded-lg border p-2.5 shadow-sm ${onChart ? 'bg-slate-50 opacity-60 dark:bg-slate-800/40' : 'bg-white hover:border-teal-300 dark:bg-slate-900 dark:hover:border-teal-700'} ${canEditLayout && !onChart ? 'cursor-grab active:cursor-grabbing' : ''} dark:border-slate-800`}>
              <GripVertical size={13} aria-hidden className="shrink-0 text-slate-300" /><div aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold" style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>{person.vacant ? <UserRound size={15} /> : person.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('')}</div>
              <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{person.vacant ? person.title : person.name}</p><p className="mt-0.5 truncate text-[11px] text-slate-500">{person.vacant ? labels.openPosition : person.title ?? '—'}</p><p className="mt-0.5 truncate text-[10px] text-slate-400">{onChart ? labels.onChart : person.department ?? labels.noDepartment}</p></div>
              {canEditLayout && <Button size="sm" variant="ghost" className="!h-7 !w-7 !p-0" disabled={onChart || saving} aria-label={`${labels.addToChart}: ${person.vacant ? person.title ?? labels.vacant : person.name}`} onClick={() => addPerson(person)}><Plus size={14} /></Button>}
            </div>
          })}
        </div>
        {palettePeople.length > 50 && <Pagination compact basePath="/hrm/org-chart" currentParams={{}} total={palettePeople.length} page={sidebarPage} perPage={50} onPageChange={setSidebarPage} />}
</>

  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <div><span className="text-sm font-semibold">{labels.canvasTitle}</span><span className="ml-3 text-xs text-slate-500">{graph.nodes.length} {labels.cardsPlaced}{dirty ? ` · ${labels.unsaved}` : ''}</span></div>
      <div className="flex flex-wrap items-center gap-2">
        {canEditLayout && <Button size="sm" variant="outline" className="md:!hidden" onClick={() => setShowPalette(true)}><Users size={14} />{labels.sidebarTitle}</Button>}
        {focusId && <Button size="sm" variant="ghost" onClick={() => { setFocusId(null); void flow.current?.fitView({ padding: 0.2, maxZoom: 1 }) }}>{labels.wholeOrganization}</Button>}
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>{labels.expandAll}</Button>
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(edges.map((edge) => edge.source)))}><GitBranch size={14} />{labels.collapseAll}</Button>
        {canEditLayout && <Button size="sm" disabled={!dirty || saving} onClick={save}><Save size={14} />{saving ? labels.saving : labels.saveLayout}</Button>}
      </div>
    </div>
    {error && <p role="alert" className="border-b bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
    {notice && <p role="status" className="px-4 py-2 text-xs text-teal-700 dark:text-teal-300">{notice}</p>}
    {editRequest && canManage && <OrgChartEditor key={`${editRequest.employmentId}:${editRequest.managerId ?? ''}`} request={editRequest} today={today} departmentOptions={departmentOptions} labels={labels} onClose={() => setEditRequest(null)} />}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {canEditLayout && <aside aria-label={labels.sidebarTitle} className="hidden shrink-0 flex-col border-r bg-white md:flex md:w-72 dark:border-slate-800 dark:bg-slate-900">{palette}</aside>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {query && visibleIds.size === 0 && <p role="status" className="bg-white px-4 py-3 text-sm text-slate-500 dark:bg-slate-900">{labels.noMatch}</p>}
        <OrgChartCanvas graph={graph} people={people} edges={edges} visibleIds={visibleIds} collapsed={collapsed} query={query} canManage={canManage && !saving} canEditLayout={canEditLayout && !saving} labels={labels}
          onOpen={open} onEdit={edit} onEditPlaceholder={editPlaceholder} onRemove={remove} onToggle={toggle} onFocus={focus} onGraphChange={updateGraph} onConnect={(source, target, oldEdge) => void connect(source, target, oldEdge)} onDeleteEdge={(edge) => void deleteEdge(edge)} onInit={init}
          onDrop={(event) => {
            if (!canEditLayout || !flow.current) return
            event.preventDefault()
            const key = event.dataTransfer.getData('application/openbooks-chart-person')
            const person = people.get(key)
            if (person) addPerson(person, flow.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
          }} />
      </div>
    </div>
    <Drawer open={showPalette} title={labels.sidebarTitle} onClose={() => setShowPalette(false)} size="sm"><div className="flex h-full min-h-0 flex-col">{palette}</div></Drawer>
    {placeholder && <Drawer open title={labels.addPlaceholder} description={labels.placeholderHint} onClose={() => void closePlaceholder()} size="sm"
      headerActions={<Button disabled={!placeholderName.trim()} onClick={savePlaceholder}>{labels.applyPlaceholder}</Button>}>
      <div className="space-y-4"><div><Label htmlFor="chart-placeholder-kind">{labels.placeholderType}</Label><Select id="chart-placeholder-kind" value={placeholder.kind} onChange={(event) => setPlaceholder({ ...placeholder, kind: event.target.value as 'department' | 'team' | 'role' })}>{(['department', 'team', 'role'] as const).map((kind) => <option key={kind} value={kind}>{labels[kind]}</option>)}</Select></div>
        <div><Label htmlFor="chart-placeholder-name">{labels.placeholderName}</Label><Input id="chart-placeholder-name" value={placeholderName} maxLength={100} onChange={(event) => setPlaceholderName(event.target.value)} /></div>
        <div><Label htmlFor="chart-placeholder-note">{labels.placeholderNote}</Label><Input id="chart-placeholder-note" value={placeholderNote} maxLength={200} onChange={(event) => setPlaceholderNote(event.target.value)} /></div>
      </div>
    </Drawer>}
  </div>
}
