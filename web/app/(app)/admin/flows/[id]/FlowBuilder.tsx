'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  ArrowLeft,
  GitBranch,
  Play,
  Plus,
  Save,
  ShieldCheck,
  TriangleAlert,
  Workflow,
  Zap,
} from 'lucide-react'
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  MarkerType,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Alert, AlertDescription, AlertTitle, Button, EmptyState, cn } from '@openbooks/ui'
import {
  lintAutomationGraph,
  profileFieldIds,
  type AutomationGraph,
  type FlowSubjectProfile,
} from '@openbooks/forms-core'
import {
  defaultNodeData,
  edgeLabel,
  fromFlow,
  newId,
  nextPosition,
  toFlow,
  type FlowNode,
  type NodeData,
  type NodeKind,
  type OrgRole,
  type OrgUser,
} from '../_builder/graph'
import { NODE_TYPES } from '../_builder/nodes'
import { Inspector } from '../_builder/Inspector'
import { RunsPanel, type FlowRunRow } from '../_builder/RunsPanel'

/**
 * The flow builder: canvas left (React Flow), inspector right (360px).
 * Serializes to AutomationGraph v1 on Save; structural errors from the API
 * block and render inline, author-time lints surface live, non-blocking.
 */

const PALETTE: { kind: NodeKind; icon: typeof Zap; labelKey: string }[] = [
  { kind: 'trigger', icon: Zap, labelKey: 'builder.palette.trigger' },
  { kind: 'condition', icon: GitBranch, labelKey: 'builder.palette.condition' },
  { kind: 'action', icon: Play, labelKey: 'builder.palette.action' },
  { kind: 'gate', icon: ShieldCheck, labelKey: 'builder.palette.gate' },
]

export default function FlowBuilder({
  flow,
  runs,
  profile,
  users,
  roles,
  permissions,
}: {
  flow: { id: string; name: string; enabled: boolean; graph: AutomationGraph }
  runs: FlowRunRow[]
  profile: FlowSubjectProfile
  users: OrgUser[]
  roles: OrgRole[]
  permissions: string[]
}) {
  const t = useTranslations('admin.flows')
  const router = useRouter()

  const edgeLabels = useMemo(
    () => ({
      then: t('edge.then'),
      else: t('edge.else'),
      approve: t('edge.approve'),
      reject: t('edge.reject'),
    }),
    [t],
  )
  const initial = useMemo(() => toFlow(flow.graph, edgeLabels), [flow.graph, edgeLabels])

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [name, setName] = useState(flow.name)
  const [enabled, setEnabled] = useState(flow.enabled)
  const [tab, setTab] = useState<'canvas' | 'runs'>('canvas')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  // Follow the app's dark theme so the canvas / minimap / controls match.
  const [isDark, setIsDark] = useState(false)
  useEffect(() => {
    const el = document.documentElement
    const sync = () => setIsDark(el.classList.contains('dark'))
    sync()
    const obs = new MutationObserver(sync)
    obs.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  // Live author-time lint — same rules the server reports on save.
  const warnings = useMemo(
    () => lintAutomationGraph(fromFlow(nodes, edges), profileFieldIds(profile), profile),
    [nodes, edges, profile],
  )

  const markDirtyOnNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      if (changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')) setDirty(true)
      onNodesChange(changes)
    },
    [onNodesChange],
  )
  const markDirtyOnEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      if (changes.some((c) => c.type !== 'select')) setDirty(true)
      onEdgesChange(changes)
    },
    [onEdgesChange],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) =>
        addEdge({ ...c, id: newId('e'), label: edgeLabel(c.sourceHandle, edgeLabels) }, eds),
      )
      setDirty(true)
    },
    [setEdges, edgeLabels],
  )

  const addNode = (kind: NodeKind) => {
    const id = newId(kind)
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      { id, type: kind, position: nextPosition(kind, ns), data: defaultNodeData(kind, profile), selected: true },
    ])
    setSelectedNodeId(id)
    setDirty(true)
  }

  const patchNodeData = (id: string, data: NodeData) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data } : n)))
    setDirty(true)
  }

  const removeNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id))
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id))
    setSelectedNodeId(null)
    setDirty(true)
  }

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/flows/${flow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || flow.name, graph: fromFlow(nodes, edges) }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSaveErrors(Array.isArray(data.errors) ? data.errors : [String(data.error ?? res.status)])
        toast.error(t('builder.saveFailed'))
        return
      }
      setSaveErrors([])
      setDirty(false)
      toast.success(t('builder.saved'))
      router.refresh()
    } catch {
      toast.error(t('builder.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled() {
    const next = !enabled
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/flows/${flow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: next,
          ...(next && dirty
            ? { name: name.trim() || flow.name, graph: fromFlow(nodes, edges) }
            : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSaveErrors(Array.isArray(data.errors) ? data.errors : [String(data.error ?? res.status)])
        toast.error(t('actions.updateFailed'))
        return
      }
      setEnabled(next)
      setSaveErrors([])
      if (next && dirty) setDirty(false)
      router.refresh()
    } catch {
      toast.error(t('actions.updateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null

  return (
    <div className="flex h-[calc(100vh-6.5rem)] min-h-[560px] flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/admin/flows"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
        >
          <ArrowLeft size={15} /> {t('title')}
        </Link>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setDirty(true)
          }}
          placeholder={t('builder.namePlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-lg font-semibold text-slate-900 outline-none hover:border-slate-200 focus:border-teal-500 dark:text-slate-100 dark:hover:border-slate-700"
        />
        <span className="text-xs text-slate-400 dark:text-slate-500">{profile.label}</span>
        {dirty ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
            {t('builder.unsaved')}
          </span>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={busy}
            onClick={toggleEnabled}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
              enabled ? 'bg-teal-500' : 'bg-slate-300 dark:bg-slate-600',
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition',
                enabled ? 'translate-x-4' : 'translate-x-0.5',
              )}
            />
          </button>
          {t('builder.enabledToggle')}
        </label>
        <Button onClick={save} disabled={busy || !dirty}>
          <Save size={15} /> {t('builder.save')}
        </Button>
      </div>

      {/* Blocking save errors / non-blocking lint warnings */}
      {saveErrors.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>{t('builder.errorsTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {saveErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : warnings.length > 0 ? (
        <details className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <summary className="flex cursor-pointer select-none items-center gap-2">
            <TriangleAlert size={14} className="shrink-0" />
            <span className="font-medium">
              {t('builder.warningsBadge', { count: warnings.length })}
            </span>
            <span className="hidden text-xs font-normal text-amber-700/80 sm:inline dark:text-amber-400/80">
              {t('builder.warningsTitle')}
            </span>
          </summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-xs">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Subtabs */}
      <div className="flex shrink-0 gap-1 border-b border-slate-200 dark:border-slate-800">
        {(['canvas', 'runs'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === k
                ? 'border-teal-500 text-teal-700 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
            )}
          >
            {t(`builder.tabs.${k}`)}
            {k === 'runs' && runs.length > 0 ? (
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500 dark:bg-slate-800">
                {runs.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'runs' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RunsPanel runs={runs} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          {/* Canvas */}
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-lg border border-slate-200 bg-white/95 p-1.5 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
              <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {t('builder.palette.title')}
              </span>
              {PALETTE.map(({ kind, icon: Icon, labelKey }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addNode(kind)}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Plus size={11} className="text-slate-400" />
                  <Icon size={13} />
                  {t(labelKey)}
                </button>
              ))}
            </div>

            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={markDirtyOnNodesChange}
              onEdgesChange={markDirtyOnEdgesChange}
              onConnect={onConnect}
              onSelectionChange={({ nodes: sel }) => setSelectedNodeId(sel[0]?.id ?? null)}
              nodeTypes={NODE_TYPES}
              colorMode={isDark ? 'dark' : 'light'}
              deleteKeyCode={['Backspace', 'Delete']}
              isValidConnection={(c) => c.source !== c.target}
              defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              minZoom={0.2}
            >
              <Background gap={18} />
              <Controls position="bottom-left" />
              <MiniMap pannable zoomable />
            </ReactFlow>

            {nodes.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <EmptyState
                  icon={<Workflow />}
                  title={t('builder.canvasEmpty.title')}
                  description={t('builder.canvasEmpty.description')}
                  className="max-w-md border-none bg-none"
                />
              </div>
            ) : null}
          </div>

          {/* Inspector */}
          <aside className="w-[360px] shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <Inspector
              node={selectedNode}
              profile={profile}
              users={users}
              roles={roles}
              permissions={permissions}
              onChange={patchNodeData}
              onDelete={removeNode}
            />
          </aside>
        </div>
      )}
    </div>
  )
}
