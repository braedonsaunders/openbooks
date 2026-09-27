'use client'

import { useCallback, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  ChevronRight,
  ClipboardCheck,
  FileSignature,
  Filter,
  ListChecks,
  MessagesSquare,
  Plus,
  Settings2,
  Star,
  Trash2,
  UserX,
} from 'lucide-react'
import { Badge, Button, Card, ContextMenu, Input, Label, cn, useContextMenu, type ContextMenuEntry } from '@openbooks/ui'
import { Switch } from '../../../../../components/switch'
import {
  BuilderHeader,
  BuilderIssues,
  BuilderSplit,
  ChoiceCards,
  InspectorFooter,
  InspectorPanel,
  OutlinePanel,
  OutlineRow,
  useDirtyReport,
  useOutlineDrag,
  type DropPlace,
} from '../../../../../components/builder/builder-kit'
import { confirmDialog } from '../../../../../lib/confirm'
import { promptDialog } from '../../../../../lib/prompt'
import {
  createSetupRow,
  deleteSetupRow,
  putJson,
  updateSetupRow,
  type BuilderErrorCopy,
} from '../../../../../lib/setup/builder-client'
import {
  moveItem,
  PIPELINE_STAGE_KINDS,
  pipelineIssues,
  stageKeyFor,
  type PipelineStageKind,
  type PipelineStageNode,
  type PipelineTemplateNode,
} from '../../../../../lib/setup/hrm-builder-outline'

type Selection = { type: 'pipeline' } | { type: 'stage'; id: string }
type DragItem = { key: string; id: string }

export const STAGE_ICON: Record<PipelineStageKind, typeof Filter> = {
  screening: Filter,
  interview: MessagesSquare,
  assessment: ClipboardCheck,
  offer: FileSignature,
  hired: BadgeCheck,
  rejected: UserX,
}

/** Stage chip colours by kind, shared with the pipeline index cards. */
export const STAGE_TONE: Record<PipelineStageKind, string> = {
  screening: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200',
  interview: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200',
  assessment: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-200',
  offer: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
  hired: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200',
  rejected: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200',
}

/** The standard funnel offered on an empty pipeline (the recruiting service's own default shape). */
const STANDARD_STAGES: readonly { key: string; kind: PipelineStageKind }[] = [
  { key: 'applied', kind: 'screening' },
  { key: 'screening', kind: 'screening' },
  { key: 'interview', kind: 'interview' },
  { key: 'offer', kind: 'offer' },
  { key: 'hired', kind: 'hired' },
  { key: 'rejected', kind: 'rejected' },
]

/**
 * The hiring-pipeline builder: one page per pipeline. A stage-flow strip
 * across the top, then the ordered stage list (drag or use the row menu to
 * reorder) beside the inspector for the pipeline or the selected stage.
 * Stage and pipeline fields save through the shared Setup API; the order
 * and the org default save through the builder's endpoints.
 */
export function PipelineBuilder({ pipeline }: { pipeline: PipelineTemplateNode }) {
  const t = useTranslations('admin.setup.pipelineBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const router = useRouter()
  const menu = useContextMenu()
  const [menuItems, setMenuItems] = useState<ContextMenuEntry[]>([])
  // An optimistic order holds only while the server data it was built on is
  // current: the refresh after a write (or a refused reorder) drops it.
  const [pending, setPending] = useState<{ base: PipelineStageNode[]; value: PipelineStageNode[] } | null>(null)
  const stages = pending && pending.base === pipeline.stages ? pending.value : pipeline.stages
  const [selection, setSelection] = useState<Selection>({ type: 'pipeline' })
  const [busy, setBusy] = useState(false)
  const dirtyRef = useRef(false)
  const reportDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
  }, [])
  const drag = useOutlineDrag<DragItem>()

  const copy: BuilderErrorCopy = {
    fallback: tc('feedback.saveFailed'),
    duplicate: t('errors.duplicateKey'),
    inUse: t('errors.stageInUse'),
    stale: tb('errors.stale'),
    network: tb('errors.network'),
  }

  const selectedStage = selection.type === 'stage' ? stages.find((stage) => stage.id === selection.id) : undefined
  const effective: Selection = selection.type === 'stage' && !selectedStage ? { type: 'pipeline' } : selection
  const issues = pipelineIssues({ isActive: pipeline.isActive, stages })
  const nextPosition = Math.max(-1, ...pipeline.stages.map((stage) => stage.position)) + 1
  const kindLabel = (kind: PipelineStageKind) => t(`kinds.${kind}.label`)

  async function select(next: Selection) {
    if (next.type === effective.type && ('id' in next ? next.id : '') === ('id' in effective ? effective.id : '')) return
    if (dirtyRef.current && !(await confirmDialog({ message: tb('discardChanges'), tone: 'danger', confirmLabel: tb('discard') }))) return
    dirtyRef.current = false
    setSelection(next)
  }

  async function persistOrder(next: PipelineStageNode[]) {
    setPending({ base: pipeline.stages, value: next })
    setBusy(true)
    const result = await putJson(`/api/admin/setup/hiring-pipelines/${pipeline.id}/stages`, { stageIds: next.map((stage) => stage.id) }, copy)
    setBusy(false)
    if (!result.ok) {
      setPending(null)
      toast.error(result.error)
    }
    router.refresh()
  }

  async function addStage() {
    const name = await promptDialog({ title: t('addStage'), label: t('fields.name'), confirmLabel: tc('actions.add') })
    if (!name) return
    setBusy(true)
    const result = await createSetupRow('hrm-pipeline-stages', {
      templateId: pipeline.id,
      position: nextPosition,
      key: stageKeyFor(name, stages.map((stage) => stage.key)),
      name,
      kind: 'interview',
    }, copy)
    if (!result.ok) {
      setBusy(false)
      toast.error(result.error)
      return
    }
    const id = result.body.id ? String(result.body.id) : null
    // A new working stage belongs before the funnel's outcomes, not after them.
    const firstOutcome = stages.findIndex((stage, index) => stage.isTerminal && stages.slice(index).every((rest) => rest.isTerminal))
    if (id && firstOutcome !== -1) {
      const ids = stages.map((stage) => stage.id)
      ids.splice(firstOutcome, 0, id)
      const ordered = await putJson(`/api/admin/setup/hiring-pipelines/${pipeline.id}/stages`, { stageIds: ids }, copy)
      if (!ordered.ok) toast.error(ordered.error)
    }
    setBusy(false)
    if (id) {
      dirtyRef.current = false
      setSelection({ type: 'stage', id })
    }
    router.refresh()
  }

  async function addStandardStages() {
    setBusy(true)
    const taken = stages.map((stage) => stage.key)
    for (const [index, stage] of STANDARD_STAGES.entries()) {
      const key = stageKeyFor(stage.key, taken)
      taken.push(key)
      const result = await createSetupRow('hrm-pipeline-stages', {
        templateId: pipeline.id,
        position: nextPosition + index,
        key,
        name: t(`standardStages.${stage.key}`),
        kind: stage.kind,
      }, copy)
      if (!result.ok) {
        toast.error(result.error)
        break
      }
    }
    setBusy(false)
    router.refresh()
  }

  async function removeStage(stage: PipelineStageNode) {
    const ok = await confirmDialog({
      title: t('deleteStageTitle'),
      message: t('deleteStage', { name: stage.name }),
      tone: 'danger',
      confirmLabel: tc('actions.delete'),
    })
    if (!ok) return
    const result = await deleteSetupRow('hrm-pipeline-stages', stage.id, copy)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('stageDeleted'))
    dirtyRef.current = false
    setSelection({ type: 'pipeline' })
    router.refresh()
  }

  async function makeDefault() {
    setBusy(true)
    const result = await putJson(`/api/admin/setup/hiring-pipelines/${pipeline.id}/default`, { isDefault: true }, copy)
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('madeDefault', { name: pipeline.name }))
    router.refresh()
  }

  async function removePipeline() {
    const ok = await confirmDialog({
      title: t('deletePipelineTitle'),
      message: t('deletePipeline', { name: pipeline.name }),
      tone: 'danger',
      confirmLabel: tc('actions.delete'),
    })
    if (!ok) return
    const result = await deleteSetupRow('hrm-pipeline-templates', pipeline.id, copy)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('pipelineDeleted'))
    router.push('/admin/setup/hiring-pipelines')
    router.refresh()
  }

  function moveBy(stage: PipelineStageNode, delta: -1 | 1) {
    const index = stages.indexOf(stage)
    const next = moveItem(stages, index, index + delta)
    if (next !== stages) void persistOrder(next)
  }

  function dropOn(target: PipelineStageNode, dragged: DragItem, place: DropPlace) {
    const from = stages.findIndex((stage) => stage.id === dragged.id)
    let to = stages.indexOf(target) + (place === 'after' ? 1 : 0)
    if (from < to) to -= 1
    const next = moveItem(stages, from, to)
    if (next !== stages) void persistOrder(next)
  }

  function openStageMenu(stage: PipelineStageNode, anchor: HTMLElement) {
    const index = stages.indexOf(stage)
    setMenuItems([
      { key: 'up', label: tb('moveUp'), icon: ArrowUp, disabled: index === 0 || busy, onSelect: () => moveBy(stage, -1) },
      { key: 'down', label: tb('moveDown'), icon: ArrowDown, disabled: index === stages.length - 1 || busy, onSelect: () => moveBy(stage, 1) },
      { key: 'sep', separator: true },
      {
        key: 'delete', label: t('deleteStageTitle'), icon: Trash2, danger: true,
        disabled: stage.totalApplications > 0,
        onSelect: () => void removeStage(stage),
      },
    ])
    menu.openBelow(anchor)
  }

  const issueList = issues.map((issue) => ({
    key: issue,
    tone: issue === 'inactive' ? ('info' as const) : ('warning' as const),
    message: t(`issues.${issue}`),
    onSelect:
      issue === 'terminalFirstStage' && stages[0]
        ? () => void select({ type: 'stage', id: stages[0]!.id })
        : issue === 'inactive'
          ? () => void select({ type: 'pipeline' })
          : undefined,
  }))

  const outline = (
    <OutlinePanel
      title={t('stages')}
      actions={
        <Button type="button" size="icon" variant="ghost" aria-label={t('addStage')} title={t('addStage')} disabled={busy} onClick={() => void addStage()}>
          <Plus size={15} />
        </Button>
      }
      footer={
        <Button type="button" variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => void addStage()}>
          <Plus size={14} /> {t('addStage')}
        </Button>
      }
    >
      <OutlineRow
        selected={effective.type === 'pipeline'}
        icon={<Settings2 size={15} />}
        label={t('pipelineSettings')}
        meta={pipeline.isDefault ? t('defaultPipeline') : t('requisitionCount', { count: pipeline.requisitionCount })}
        onSelect={() => void select({ type: 'pipeline' })}
      />
      <div className="my-1.5 border-t border-slate-100 dark:border-slate-800" />
      {stages.length === 0 ? (
        <div className="space-y-3 px-3 py-6 text-center">
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('noStages')}</p>
          <Button type="button" size="sm" disabled={busy} onClick={() => void addStandardStages()}>
            <ListChecks size={14} /> {t('useStandardStages')}
          </Button>
        </div>
      ) : (
        <ol className="space-y-0.5">
          {stages.map((stage, index) => {
            const Icon = STAGE_ICON[stage.kind]
            return (
              <li key={stage.id}>
                <OutlineRow
                  selected={effective.type === 'stage' && effective.id === stage.id}
                  icon={<Icon size={15} />}
                  label={stage.name}
                  meta={[kindLabel(stage.kind), stage.key].join(' · ')}
                  trailing={
                    <span className="flex shrink-0 items-center gap-1.5">
                      {stage.activeApplications > 0 ? (
                        <Badge variant="outline" className="tabular-nums" title={t('activeApplications', { count: stage.activeApplications })}>
                          {stage.activeApplications}
                        </Badge>
                      ) : null}
                      <span className="w-5 text-right text-xs text-slate-400 tabular-nums">{index + 1}</span>
                    </span>
                  }
                  onSelect={() => void select({ type: 'stage', id: stage.id })}
                  onMenu={(anchor) => openStageMenu(stage, anchor)}
                  menuLabel={tb('rowActions')}
                  grabLabel={tb('dragToReorder')}
                  drag={drag.bind(stage.id, { key: stage.id, id: stage.id }, {
                    canDrop: () => true,
                    onDrop: (dragged, place) => dropOn(stage, dragged, place),
                  })}
                  dropPlace={drag.dropPlace(stage.id)}
                  dimmed={drag.dragging?.key === stage.id}
                />
              </li>
            )
          })}
        </ol>
      )}
    </OutlinePanel>
  )

  let inspector: ReactNode
  if (effective.type === 'stage' && selectedStage) {
    inspector = (
      <StageInspector
        key={`${selectedStage.id}:${selectedStage.name}:${selectedStage.key}:${selectedStage.kind}`}
        stage={selectedStage}
        index={stages.indexOf(selectedStage)}
        takenKeys={stages.filter((stage) => stage.id !== selectedStage.id).map((stage) => stage.key)}
        copy={copy}
        onDirty={reportDirty}
        onSaved={() => {
          dirtyRef.current = false
          router.refresh()
        }}
        onDelete={() => void removeStage(selectedStage)}
      />
    )
  } else {
    inspector = (
      <PipelineInspector
        key={`${pipeline.name}:${pipeline.isActive}:${pipeline.isDefault}`}
        pipeline={pipeline}
        busy={busy}
        copy={copy}
        onDirty={reportDirty}
        onSaved={() => {
          dirtyRef.current = false
          router.refresh()
        }}
        onMakeDefault={() => void makeDefault()}
      />
    )
  }

  return (
    <div>
      <BuilderHeader
        backHref="/admin/setup/hiring-pipelines"
        backLabel={t('backToPipelines')}
        title={pipeline.name}
        badges={
          <>
            {pipeline.isDefault ? <Badge variant="success">{t('default')}</Badge> : null}
            {pipeline.isActive ? null : <Badge variant="secondary">{tb('inactive')}</Badge>}
          </>
        }
        status={busy ? <span className="text-xs text-slate-500 dark:text-slate-400">{tc('actions.saving')}</span> : null}
        actions={
          <>
            {!pipeline.isDefault && pipeline.isActive ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void makeDefault()}>
                <Star size={14} /> {t('makeDefault')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pipeline.requisitionCount > 0 || pipeline.isDefault}
              title={pipeline.requisitionCount > 0 ? t('deleteBlocked') : pipeline.isDefault ? t('deleteDefaultBlocked') : undefined}
              onClick={() => void removePipeline()}
            >
              <Trash2 size={14} /> {tc('actions.delete')}
            </Button>
          </>
        }
      />
      <StageFlow
        stages={stages}
        selectedId={effective.type === 'stage' ? effective.id : null}
        onSelect={(id) => void select({ type: 'stage', id })}
        kindLabel={kindLabel}
      />
      <BuilderSplit outline={outline}>
        <BuilderIssues issues={issueList} />
        {inspector}
      </BuilderSplit>
      <ContextMenu open={menu.open} position={menu.position} items={menuItems} onClose={menu.close} />
    </div>
  )
}

/** The funnel left to right, as candidates travel it. */
function StageFlow({
  stages,
  selectedId,
  onSelect,
  kindLabel,
}: {
  stages: PipelineStageNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  kindLabel: (kind: PipelineStageKind) => string
}) {
  const t = useTranslations('admin.setup.pipelineBuilder')
  if (stages.length === 0) return null
  return (
    <Card className="mb-5 overflow-x-auto px-4 py-3">
      <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">{t('flow')}</p>
      <ol className="flex min-w-max items-center gap-1.5">
        {stages.map((stage, index) => {
          const Icon = STAGE_ICON[stage.kind]
          const selected = stage.id === selectedId
          return (
            <li key={stage.id} className="flex items-center gap-1.5">
              {index > 0 ? <ChevronRight size={14} className="shrink-0 text-slate-300 dark:text-slate-600" aria-hidden /> : null}
              <button
                type="button"
                onClick={() => onSelect(stage.id)}
                aria-current={selected ? 'true' : undefined}
                title={kindLabel(stage.kind)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-shadow',
                  STAGE_TONE[stage.kind],
                  selected ? 'ring-2 ring-teal-500 ring-offset-1 dark:ring-offset-slate-900' : 'hover:shadow-sm',
                )}
              >
                <Icon size={13} />
                {stage.name}
                {stage.activeApplications > 0 ? (
                  <span className="rounded-full bg-white/80 px-1.5 text-[10px] tabular-nums dark:bg-slate-900/60">{stage.activeApplications}</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function PipelineInspector({
  pipeline,
  busy: pageBusy,
  copy,
  onDirty,
  onSaved,
  onMakeDefault,
}: {
  pipeline: PipelineTemplateNode
  busy: boolean
  copy: BuilderErrorCopy
  onDirty: (dirty: boolean) => void
  onSaved: () => void
  onMakeDefault: () => void
}) {
  const t = useTranslations('admin.setup.pipelineBuilder')
  const tb = useTranslations('admin.setup.builder')
  const initial = { name: pipeline.name, isActive: pipeline.isActive }
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = draft.name !== initial.name || draft.isActive !== initial.isActive
  useDirtyReport(dirty, onDirty)

  async function save() {
    if (!draft.name.trim()) {
      setError(t('errors.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const result = await updateSetupRow('hrm-pipeline-templates', pipeline.id, { name: draft.name.trim(), isActive: draft.isActive }, {
      ...copy,
      duplicate: t('errors.duplicateName'),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      toast.error(result.error)
      return
    }
    toast.success(tb('saved'))
    onSaved()
  }

  return (
    <InspectorPanel
      icon={<Settings2 size={18} />}
      eyebrow={t('pipelineSettings')}
      title={draft.name || pipeline.name}
      error={error}
      footer={<InspectorFooter dirty={dirty} busy={busy} onDiscard={() => { setDraft(initial); setError(null) }} onSave={() => void save()} />}
    >
      <div className="space-y-1.5">
        <Label htmlFor="pipeline-name">{t('fields.pipelineName')}</Label>
        <Input id="pipeline-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{tb('active')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{pipeline.isDefault ? t('help.defaultStaysActive') : t('help.active')}</p>
        </div>
        <Switch
          on={draft.isActive}
          disabled={busy || pipeline.isDefault}
          label={tb('active')}
          onToggle={() => setDraft({ ...draft, isActive: !draft.isActive })}
        />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('default')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{pipeline.isDefault ? t('help.isDefault') : t('help.notDefault')}</p>
        </div>
        {pipeline.isDefault ? (
          <Badge variant="success">{t('default')}</Badge>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={pageBusy || !pipeline.isActive || dirty} onClick={onMakeDefault}>
            <Star size={14} /> {t('makeDefault')}
          </Button>
        )}
      </div>
      <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
        {pipeline.requisitionCount > 0 ? t('help.historyPinned', { count: pipeline.requisitionCount }) : t('help.noRequisitions')}
      </p>
    </InspectorPanel>
  )
}

function StageInspector({
  stage,
  index,
  takenKeys,
  copy,
  onDirty,
  onSaved,
  onDelete,
}: {
  stage: PipelineStageNode
  index: number
  takenKeys: string[]
  copy: BuilderErrorCopy
  onDirty: (dirty: boolean) => void
  onSaved: () => void
  onDelete: () => void
}) {
  const t = useTranslations('admin.setup.pipelineBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const initial = { name: stage.name, key: stage.key, kind: stage.kind }
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = draft.name !== initial.name || draft.key !== initial.key || draft.kind !== initial.kind
  useDirtyReport(dirty, onDirty)
  const Icon = STAGE_ICON[draft.kind]

  async function save() {
    if (!draft.name.trim()) {
      setError(t('errors.stageNameRequired'))
      return
    }
    if (!draft.key.trim()) {
      setError(t('errors.keyRequired'))
      return
    }
    if (takenKeys.includes(draft.key.trim())) {
      setError(t('errors.duplicateKey'))
      return
    }
    setBusy(true)
    setError(null)
    const result = await updateSetupRow('hrm-pipeline-stages', stage.id, { name: draft.name.trim(), key: draft.key.trim(), kind: draft.kind }, copy)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      toast.error(result.error)
      return
    }
    toast.success(tb('saved'))
    onSaved()
  }

  const kindOptions = PIPELINE_STAGE_KINDS.map((kind) => {
    const KindIcon = STAGE_ICON[kind]
    return { value: kind, label: t(`kinds.${kind}.label`), description: t(`kinds.${kind}.description`), icon: <KindIcon size={16} /> }
  })

  return (
    <InspectorPanel
      icon={<Icon size={18} />}
      eyebrow={t('stageNumber', { number: index + 1 })}
      title={draft.name || stage.name}
      error={error}
      footer={
        <InspectorFooter
          dirty={dirty}
          busy={busy}
          onDiscard={() => { setDraft(initial); setError(null) }}
          onSave={() => void save()}
          extra={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700 dark:text-red-400"
              disabled={stage.totalApplications > 0}
              title={stage.totalApplications > 0 ? t('deleteStageBlocked') : undefined}
              onClick={onDelete}
            >
              <Trash2 size={14} /> {tc('actions.delete')}
            </Button>
          }
        />
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="stage-name">{t('fields.name')}</Label>
          <Input id="stage-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="stage-key" help={t('help.key')}>{t('fields.key')}</Label>
          <Input id="stage-key" className="font-mono text-sm" value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>{t('fields.kind')}</Label>
        <ChoiceCards ariaLabel={t('fields.kind')} value={draft.kind} options={kindOptions} onChange={(kind) => setDraft({ ...draft, kind })} />
        {draft.kind === 'hired' || draft.kind === 'rejected' ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('help.terminal')}</p>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t('activeApplicationsLabel')} value={stage.activeApplications} />
        <Stat label={t('totalApplicationsLabel')} value={stage.totalApplications} />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('kits')}</p>
          <Link href="/hrm/recruiting?tab=interviews" className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('manageKits')}
          </Link>
        </div>
        {stage.kits.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('noKits')}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {stage.kits.map((kit) => (
              <li key={kit.id}>
                <Badge variant={kit.isActive ? 'outline' : 'secondary'}>{kit.name}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      {stage.totalApplications > 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">{t('deleteStageBlocked')}</p>
      ) : null}
    </InspectorPanel>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="text-lg font-semibold text-slate-900 tabular-nums dark:text-slate-100">{value}</p>
    </div>
  )
}
