'use client'

import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { ChevronDown, ChevronUp, Crosshair, Pencil, UserRound, Users } from 'lucide-react'
import { Button } from '@openbooks/ui'
import type { OrgChartNode } from '@openbooks/engine/src/hrm/org-chart.ts'
import { CARD_HEIGHT, CARD_WIDTH, canConnectManager, departmentColor, layoutChart } from './graph'

type PersonData = Record<string, unknown> & {
  person: OrgChartNode
  collapsed: boolean
  highlighted: boolean
  context: boolean
  editing: boolean
  canManage: boolean
  labels: Record<string, string>
  open: (node: OrgChartNode) => void
  edit: (node: OrgChartNode, managerId?: string) => void
  focus: (node: OrgChartNode) => void
  toggle: (id: string) => void
}
type PersonNode = Node<PersonData, 'person'>

function PersonCard({ id, data }: NodeProps<PersonNode>) {
  const { person, labels } = data
  const color = departmentColor(person.department)
  const initials = person.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('')
  return (
    <div style={{ width: CARD_WIDTH, height: CARD_HEIGHT, borderTopColor: color }}
      className={`overflow-hidden rounded-xl border border-t-[3px] bg-white shadow-sm transition-shadow hover:shadow-md dark:border-slate-700 dark:bg-slate-900 ${person.vacant ? 'border-dashed' : ''} ${data.highlighted ? 'ring-2 ring-teal-500' : ''} ${data.context ? 'opacity-60' : ''}`}>
      {!person.vacant && <Handle type="target" position={Position.Top} isConnectable={data.editing} className={data.editing ? '!h-3 !w-3 !bg-teal-600' : '!opacity-0'} aria-label={labels.employeeConnector} />}
      <div className="flex h-[122px] gap-3 px-4 py-3">
        <div aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>
          {person.vacant ? <UserRound size={18} /> : initials}
        </div>
        <div className="min-w-0 flex-1">
          <button type="button" disabled={person.vacant} onClick={() => data.open(person)}
            className="nodrag block w-full truncate text-left text-sm font-semibold text-slate-900 hover:text-teal-700 focus-visible:outline-2 dark:text-slate-100 dark:hover:text-teal-300" title={person.name}>
            {person.vacant ? labels.vacant : person.name}
          </button>
          <p className="mt-1 line-clamp-2 text-xs leading-4 text-slate-500 dark:text-slate-400" title={person.title ?? person.positionCode ?? undefined}>{person.title ?? person.positionCode ?? '—'}</p>
          <p className="mt-2 truncate text-[11px] text-slate-500 dark:text-slate-400">{person.department ?? labels.noDepartment}</p>
        </div>
      </div>
      <div className="flex h-[39px] items-center justify-between border-t bg-slate-50/70 px-2 dark:border-slate-800 dark:bg-slate-800/40">
        {person.children.length > 0 ? (
          <button type="button" aria-expanded={!data.collapsed} aria-label={data.collapsed ? labels.expand : labels.collapse}
            onClick={() => data.toggle(id)} className="nodrag flex items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-200 focus-visible:outline-2 dark:text-slate-300 dark:hover:bg-slate-700">
            <Users size={13} /><span>{person.spanOfControl}</span>{data.collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
        ) : <span className="px-2 text-[11px] text-slate-400">{person.vacant ? labels.openPosition : labels.noReports}</span>}
        {!person.vacant && <div className="flex gap-0.5">
          <Button variant="ghost" size="sm" className="nodrag !h-7 !w-7 !p-0" aria-label={`${labels.focus}: ${person.name}`} title={labels.focus} onClick={() => data.focus(person)}><Crosshair size={14} /></Button>
          {data.canManage && <Button variant="ghost" size="sm" className="nodrag !h-7 !w-7 !p-0" aria-label={`${labels.edit}: ${person.name}`} title={labels.edit} onClick={() => data.edit(person)}><Pencil size={13} /></Button>}
        </div>}
      </div>
      {!person.vacant && <Handle type="source" position={Position.Bottom} isConnectable={data.editing} className={data.editing ? '!h-3 !w-3 !bg-teal-600' : '!opacity-0'} aria-label={labels.managerConnector} />}
    </div>
  )
}

const NODE_TYPES = { person: PersonCard }

/** Uses the same React Flow canvas, controls and minimap as the automation builder. */
export function OrgChartCanvas({ roots, allRoots, collapsed, query, department, editing, canManage, labels, onOpen, onEdit, onFocus, onToggle, onRefusal }: {
  roots: OrgChartNode[]
  allRoots: OrgChartNode[]
  collapsed: Set<string>
  query: string
  department: string
  editing: boolean
  canManage: boolean
  labels: Record<string, string>
  onOpen: PersonData['open']
  onEdit: PersonData['edit']
  onFocus: PersonData['focus']
  onToggle: PersonData['toggle']
  onRefusal: (message: string) => void
}) {
  const [flow, setFlow] = useState<ReactFlowInstance<PersonNode> | null>(null)
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const sync = () => setDark(document.documentElement.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  const layout = useMemo(() => layoutChart(roots, collapsed, query, department), [roots, collapsed, query, department])
  const nodes = useMemo<PersonNode[]>(() => layout.nodes.map((node) => ({
    id: node.id, type: 'person', position: node.position, width: CARD_WIDTH, height: CARD_HEIGHT,
    data: { ...node, labels, editing, canManage, open: onOpen, edit: onEdit, focus: onFocus, toggle: onToggle },
  })), [layout, labels, editing, canManage, onOpen, onEdit, onFocus, onToggle])
  // Dimensions are explicit, so fit works for newly expanded or searched branches.
  useEffect(() => {
    if (flow) void flow.fitView({ nodes: layout.nodes.map(({ id }) => ({ id })), padding: 0.15, maxZoom: 1, duration: 250 })
  }, [flow, layout])

  return (
    <div className="relative h-full min-h-[480px] flex-1" data-testid="org-chart-canvas">
      <ReactFlow<PersonNode>
        nodes={nodes} edges={layout.edges.map((edge) => ({ ...edge, type: 'smoothstep', style: { stroke: dark ? '#64748b' : '#94a3b8', strokeWidth: 1.5 } }))}
        nodeTypes={NODE_TYPES} onInit={setFlow} colorMode={dark ? 'dark' : 'light'}
        nodesDraggable={false} nodesConnectable={editing && canManage} edgesReconnectable={false} elementsSelectable={false}
        edgesFocusable={false} deleteKeyCode={null} minZoom={0.15} maxZoom={1.75} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        isValidConnection={(connection) => Boolean(connection.source && connection.target && canConnectManager(allRoots, connection.source, connection.target))}
        onConnect={(connection) => {
          if (!canManage || !editing || !connection.source || !connection.target) return
          if (!canConnectManager(allRoots, connection.source, connection.target)) { onRefusal(labels.invalidConnection); return }
          const employee = layout.nodes.find((node) => node.id === connection.target)?.person
          if (employee) onEdit(employee, connection.source)
        }}
        ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': labels.zoomIn, 'controls.zoomOut.ariaLabel': labels.zoomOut, 'controls.fitView.ariaLabel': labels.fit }}>
        <Background gap={24} size={1} color={dark ? '#334155' : '#cbd5e1'} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" className="!hidden sm:!block" nodeColor={(node) => departmentColor(node.data.person.department)} pannable zoomable ariaLabel={labels.minimap} />
        <Panel position="top-left"><span className="rounded-lg border bg-white/90 px-3 py-2 text-xs text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-400">{editing ? labels.connectHint : labels.panHint}</span></Panel>
        {layout.nodes.length === 0 && <Panel position="top-center"><p role="status" className="rounded-lg border bg-white p-4 text-sm dark:bg-slate-900">{labels.noMatch}</p></Panel>}
      </ReactFlow>
    </div>
  )
}
