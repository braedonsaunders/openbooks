'use client'

import type { OrgChartLabels } from './graph'

import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, applyNodeChanges, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { Building2, ChevronDown, ChevronUp, Crosshair, Pencil, UserRound, Users, X } from 'lucide-react'
import { Button } from '@openbooks/ui'
import type { OrgChartNode } from '@openbooks/engine/hrm/org-chart/contracts'
import type { OrgChartLayout, OrgChartLayoutNode } from '@openbooks/engine/hrm/org-chart/contracts'
import { CARD_HEIGHT, CARD_WIDTH, departmentColor } from './graph'

type CardData = Record<string, unknown> & {
  card: OrgChartLayoutNode
  person?: OrgChartNode
  labels: OrgChartLabels
  canManage: boolean
  canEditLayout: boolean
  collapsed: boolean
  hasChildren: boolean
  highlighted: boolean
  open: (node: OrgChartNode) => void
  edit: (node: OrgChartNode) => void
  editPlaceholder: (node: OrgChartLayoutNode) => void
  remove: (id: string) => void
  toggle: (id: string) => void
  focus: (id: string) => void
}
export type ChartFlowNode = Node<CardData, 'person'>
export type ChartFlowInstance = ReactFlowInstance<ChartFlowNode>

function ChartCard({ id, data }: NodeProps<ChartFlowNode>) {
  const { card, person, labels } = data
  const placeholder = !card.referenceId
  const name = placeholder ? card.label! : person ? (person.vacant ? labels.vacant : person.name) : labels.unavailablePerson
  const kindLabel = card.kind === 'department' || card.kind === 'team' || card.kind === 'role' ? labels[card.kind] : labels.placeholder
  const title = placeholder ? (card.note || kindLabel) : (person?.title ?? person?.positionCode ?? labels.unavailableHint)
  const color = departmentColor(person?.department ?? (placeholder ? card.kind : null))
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('')
  const vacant = card.kind === 'vacancy' || card.kind === 'role'
  return <div style={{ width: CARD_WIDTH, height: CARD_HEIGHT, borderTopColor: color }}
    className={`overflow-hidden rounded-xl border border-t-[3px] bg-white shadow-sm transition-shadow hover:shadow-md dark:border-slate-700 dark:bg-slate-900 ${placeholder || vacant ? 'border-dashed' : ''} ${data.highlighted ? 'ring-2 ring-teal-500' : ''}`}>
    <Handle type="target" position={Position.Top} isConnectable={data.canManage || data.canEditLayout} className="!h-2.5 !w-2.5 !bg-slate-400" aria-label={labels.employeeConnector} />
    <div className="flex h-[122px] gap-3 px-4 py-3">
      <div aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>
        {placeholder ? (card.kind === 'role' ? <UserRound size={18} /> : <Building2 size={18} />) : vacant ? <UserRound size={18} /> : initials}
      </div>
      <div className="min-w-0 flex-1">
        <button type="button" disabled={placeholder ? !data.canEditLayout : !person?.employmentId} onClick={() => placeholder ? data.editPlaceholder(card) : person && data.open(person)}
          className="nodrag block w-full truncate text-left text-sm font-semibold text-slate-900 hover:text-teal-700 focus-visible:outline-2 dark:text-slate-100 dark:hover:text-teal-300" title={name}>{name}</button>
        <p className="mt-1 line-clamp-2 text-xs leading-4 text-slate-500 dark:text-slate-400" title={title}>{title}</p>
        <p className="mt-2 truncate text-[11px] text-slate-500 dark:text-slate-400">{placeholder ? `${kindLabel} · ${labels.placeholder}` : person?.department ?? labels.noDepartment}</p>
      </div>
    </div>
    <div className="flex h-[39px] items-center justify-between border-t bg-slate-50/70 px-2 dark:border-slate-800 dark:bg-slate-800/40">
      {data.hasChildren ? <button type="button" aria-expanded={!data.collapsed} aria-label={data.collapsed ? labels.expand : labels.collapse} onClick={() => data.toggle(id)}
        className="nodrag flex items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-200 focus-visible:outline-2 dark:text-slate-300 dark:hover:bg-slate-700"><Users size={13} /><span>{person?.spanOfControl ?? ''}</span>{data.collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button>
        : <span className="px-2 text-[11px] text-slate-400">{placeholder ? labels.placeholder : vacant ? labels.openPosition : person?.spanOfControl ? `${person.spanOfControl} ${labels.reports}` : labels.noReports}</span>}
      <div className="flex gap-0.5">
        <Button variant="ghost" size="sm" className="nodrag !h-7 !w-7 !p-0" aria-label={`${labels.focus}: ${name}`} title={labels.focus} onClick={() => data.focus(id)}><Crosshair size={14} /></Button>
        {(placeholder ? data.canEditLayout : data.canManage && person?.employmentId) && <Button variant="ghost" size="sm" className="nodrag !h-7 !w-7 !p-0" aria-label={`${labels.edit}: ${name}`} title={labels.edit} onClick={() => placeholder ? data.editPlaceholder(card) : person && data.edit(person)}><Pencil size={13} /></Button>}
        {data.canEditLayout && <Button variant="ghost" size="sm" className="nodrag !h-7 !w-7 !p-0" aria-label={`${labels.removeCard}: ${name}`} title={labels.removeCard} onClick={() => data.remove(id)}><X size={13} /></Button>}
      </div>
    </div>
    <Handle type="source" position={Position.Bottom} isConnectable={data.canManage || data.canEditLayout} className="!h-2.5 !w-2.5 !bg-slate-400" aria-label={labels.managerConnector} />
  </div>
}
const NODE_TYPES = { person: ChartCard }

/** The house React Flow canvas; positions persist, employee edges are read from canonical HR data. */
export function OrgChartCanvas({ graph, people, edges, visibleIds, collapsed, query, canManage, canEditLayout, labels, onOpen, onEdit, onEditPlaceholder, onRemove, onToggle, onFocus, onGraphChange, onConnect, onDeleteEdge, onInit, onDrop }: {
  graph: OrgChartLayout
  people: Map<string, OrgChartNode>
  edges: Edge[]
  visibleIds: Set<string>
  collapsed: Set<string>
  query: string
  canManage: boolean
  canEditLayout: boolean
  labels: OrgChartLabels
  onOpen: CardData['open']; onEdit: CardData['edit']; onEditPlaceholder: CardData['editPlaceholder']; onRemove: CardData['remove']; onToggle: CardData['toggle']; onFocus: CardData['focus']
  onGraphChange: (graph: OrgChartLayout) => void
  onConnect: (source: string, target: string, oldEdge?: Edge) => void
  onDeleteEdge: (edge: Edge) => void
  onInit: (flow: ChartFlowInstance) => void
  onDrop: (event: React.DragEvent) => void
}) {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const sync = () => setDark(document.documentElement.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  const parents = useMemo(() => new Set(edges.map(edge => edge.source)), [edges])
  const nodes = useMemo<ChartFlowNode[]>(() => graph.nodes.filter((card) => visibleIds.has(card.id)).map((card) => {
    const person = card.referenceId ? people.get(`${card.kind}:${card.referenceId}`) : undefined
    const text = [person?.name, person?.title, person?.department, card.label, card.note].filter(Boolean).join(' ').toLocaleLowerCase()
    return { id: card.id, type: 'person', position: card.position, width: CARD_WIDTH, height: CARD_HEIGHT,
      data: { card, person, labels, canManage, canEditLayout, collapsed: collapsed.has(card.id), hasChildren: parents.has(card.id), highlighted: Boolean(query && text.includes(query)), open: onOpen, edit: onEdit, editPlaceholder: onEditPlaceholder, remove: onRemove, toggle: onToggle, focus: onFocus } }
  }), [graph.nodes, people, visibleIds, collapsed, query, parents, labels, canManage, canEditLayout, onOpen, onEdit, onEditPlaceholder, onRemove, onToggle, onFocus])
  return <div className="relative h-full min-h-0 flex-1" onDragOver={(event) => { if (canEditLayout) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }} onDrop={onDrop} data-testid="org-chart-canvas">
    <ReactFlow<ChartFlowNode> nodes={nodes} edges={edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((edge) => ({ ...edge, style: { stroke: edge.data?.canonical ? '#0d9488' : '#94a3b8', strokeWidth: 1.5, strokeDasharray: edge.data?.canonical ? undefined : '5 4' }, type: 'smoothstep' }))}
      nodeTypes={NODE_TYPES} onInit={onInit} colorMode={dark ? 'dark' : 'light'} nodesDraggable={canEditLayout} nodesConnectable={canManage || canEditLayout} edgesReconnectable={canManage || canEditLayout}
      onNodesChange={(changes) => {
        if (!canEditLayout || !changes.some((change) => change.type === 'position')) return
        const moved = applyNodeChanges(changes.filter((change) => change.type === 'position'), nodes)
        const positions = new Map(moved.map((node) => [node.id, node.position]))
        onGraphChange({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) })
      }}
      onConnect={(connection) => { if (connection.source && connection.target) onConnect(connection.source, connection.target) }}
      onReconnect={(oldEdge, connection) => { if (connection.source && connection.target) onConnect(connection.source, connection.target, oldEdge) }}
      onEdgeClick={(_, edge) => onDeleteEdge(edge)}
      onlyRenderVisibleElements deleteKeyCode={null} edgesFocusable elementsSelectable={false} minZoom={0.15} maxZoom={1.75} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': labels.zoomIn, 'controls.zoomOut.ariaLabel': labels.zoomOut, 'controls.fitView.ariaLabel': labels.fit }}>
      <Background gap={24} size={1} color={dark ? '#334155' : '#cbd5e1'} /><Controls position="bottom-left" showInteractive={false} />
      <MiniMap<ChartFlowNode> position="bottom-right" className="!hidden lg:!block" nodeColor={(node) => departmentColor(node.data.person?.department ?? node.data.card.kind)} pannable zoomable ariaLabel={labels.minimap} />
      <Panel position="top-left"><span className="rounded-lg border bg-white/90 px-3 py-2 text-xs text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-400">{labels.panHint}</span></Panel>
      {graph.nodes.length === 0 && <Panel position="top-center" className="!top-1/3 !max-w-80 !text-center"><div className="rounded-2xl border border-dashed bg-white/95 px-8 py-7 shadow-sm dark:border-slate-700 dark:bg-slate-900/95"><Building2 className="mx-auto mb-3 text-teal-600" size={28} /><h3 className="font-semibold">{labels.startEmpty}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{canEditLayout ? labels.startHint : labels.readOnlyEmpty}</p></div></Panel>}
    </ReactFlow>
  </div>
}
