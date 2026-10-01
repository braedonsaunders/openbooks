'use client'

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  Award,
  ClipboardList,
  Eye,
  MessageSquareText,
  Plus,
  Settings2,
  Star,
  Target,
  Trash2,
  Type,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  ContextMenu,
  Input,
  Label,
  PageHeader,
  SearchSelect,
  TagInput,
  Textarea,
  cn,
  useContextMenu,
  type ContextMenuEntry,
} from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
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
  postJson,
  putJson,
  updateSetupRow,
  type BuilderErrorCopy,
} from '../../../../../lib/setup/builder-client'
import {
  moveItem,
  moveQuestion,
  outlineOrder,
  REVIEW_ANSWER_KINDS,
  REVIEW_SECTION_KINDS,
  reviewTemplateIssues,
  type ReviewAnswerKind,
  type ReviewQuestionNode,
  type ReviewSectionKind,
  type ReviewSectionNode,
  type ReviewTemplateNode,
} from '../../../../../lib/setup/hrm-builder-outline'

export interface CompetencyChoice {
  id: string
  label: string
  framework: string
}

type Selection = { type: 'template' } | { type: 'section'; id: string } | { type: 'question'; id: string }
type DragItem = { key: string; type: 'section' | 'question'; id: string }

const SECTION_ICON: Record<ReviewSectionKind, typeof Award> = { competency: Award, goals: Target, free_text: AlignLeft }
const ANSWER_ICON: Record<ReviewAnswerKind, typeof Star> = { rating: Star, text: Type, rating_and_text: MessageSquareText }
/** Option-label keys in admin.setup.options (camel-cased values). */
const SECTION_KIND_KEY: Record<ReviewSectionKind, string> = { competency: 'competency', goals: 'goals', free_text: 'freeText' }
const ANSWER_KIND_KEY: Record<ReviewAnswerKind, string> = { rating: 'rating', text: 'text', rating_and_text: 'ratingAndText' }
const DEFAULT_ANSWER: Record<ReviewSectionKind, ReviewAnswerKind> = { competency: 'rating_and_text', goals: 'rating_and_text', free_text: 'text' }

/** Parse a decimal the way the inspector accepts it: blank is "no value". */
function decimalOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * The review-template builder: one page per template. Left, the outline
 * (template settings, then sections with their questions — drag or use the
 * row menu to reorder, a question can be dragged into another section);
 * right, the inspector for the selected node and a live preview of the form
 * reviewers fill in. Row fields save through the shared Setup API; the
 * outline order saves through the builder's order endpoint.
 */
export function ReviewTemplateBuilder({
  template,
  competencies,
  basePath = '/admin/setup/review-templates',
  cycleHref,
}: {
  basePath?: string
  cycleHref?: string | null
  template: ReviewTemplateNode
  competencies: CompetencyChoice[] | null
}) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const th = useTranslations('hrm')
  const router = useRouter()
  const menu = useContextMenu()
  const [menuItems, setMenuItems] = useState<ContextMenuEntry[]>([])
  // An optimistic outline holds only while the server data it was built
  // on is current: the refresh after a write (or a refused reorder) drops it.
  const [pending, setPending] = useState<{ base: ReviewSectionNode[]; value: ReviewSectionNode[] } | null>(null)
  const sections = pending && pending.base === template.sections ? pending.value : template.sections
  const [selection, setSelection] = useState<Selection>({ type: 'template' })
  const [reordering, setReordering] = useState(false)
  const dirtyRef = useRef(false)
  const reportDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
  }, [])
  const drag = useOutlineDrag<DragItem>()

  const copy: BuilderErrorCopy = {
    fallback: tc('feedback.saveFailed'),
    duplicate: tb('errors.duplicate'),
    inUse: tb('errors.inUse'),
    stale: tb('errors.stale'),
    network: tb('errors.network'),
  }

  const allQuestions = useMemo(() => sections.flatMap((section) => section.questions), [sections])
  const selectedSection = selection.type === 'section' ? sections.find((section) => section.id === selection.id) : undefined
  const selectedQuestion = selection.type === 'question' ? allQuestions.find((question) => question.id === selection.id) : undefined
  // A node deleted underneath the selection falls back to the template.
  const effective: Selection =
    (selection.type === 'section' && !selectedSection) || (selection.type === 'question' && !selectedQuestion)
      ? { type: 'template' }
      : selection
  const weightTotal = sections.reduce((sum, section) => sum + (section.weight ? Number(section.weight) : 0), 0)
  const templateView: ReviewTemplateNode = { ...template, sections }
  const issues = reviewTemplateIssues(templateView)

  async function select(next: Selection) {
    if (next.type === effective.type && ('id' in next ? next.id : '') === ('id' in effective ? effective.id : '')) return
    if (dirtyRef.current && !(await confirmDialog({ message: tb('discardChanges'), tone: 'danger', confirmLabel: tb('discard') }))) return
    dirtyRef.current = false
    setSelection(next)
  }

  async function persistOrder(next: ReviewSectionNode[]) {
    setPending({ base: template.sections, value: next })
    setReordering(true)
    const result = await putJson(`/api/admin/setup/review-templates/${template.id}/outline`, outlineOrder(next), copy)
    setReordering(false)
    if (!result.ok) {
      setPending(null)
      toast.error(result.error)
    }
    router.refresh()
  }

  // Positions are unique per parent. The next row takes a position past
  // every stored one (server data, not the optimistic outline), so a create
  // can never collide; the order endpoint compacts positions on reorder.
  const nextSectionPosition = Math.max(-1, ...template.sections.map((section) => section.position)) + 1
  const nextQuestionPosition =
    Math.max(-1, ...template.sections.flatMap((section) => section.questions.map((question) => question.position))) + 1

  async function addSection() {
    const title = await promptDialog({ title: t('addSection'), label: t('fields.sectionTitle'), confirmLabel: tc('actions.add') })
    if (!title) return
    const result = await createSetupRow('hrm-review-template-sections', {
      templateId: template.id, position: nextSectionPosition, title, kind: 'competency',
    }, copy)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (result.body.id) {
      dirtyRef.current = false
      setSelection({ type: 'section', id: String(result.body.id) })
    }
    router.refresh()
  }

  async function addQuestion(section: ReviewSectionNode) {
    const prompt = await promptDialog({ title: t('addQuestionTo', { section: section.title }), label: t('fields.prompt'), confirmLabel: tc('actions.add') })
    if (!prompt) return
    const result = await createSetupRow('hrm-review-template-questions', {
      sectionId: section.id, position: nextQuestionPosition, prompt, answerKind: DEFAULT_ANSWER[section.kind], required: true,
    }, copy)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (result.body.id) {
      dirtyRef.current = false
      setSelection({ type: 'question', id: String(result.body.id) })
    }
    router.refresh()
  }

  async function removeSection(section: ReviewSectionNode) {
    const ok = await confirmDialog({
      title: t('deleteSectionTitle'),
      message: section.questions.length > 0
        ? t('deleteSectionWithQuestions', { title: section.title, count: section.questions.length })
        : t('deleteSection', { title: section.title }),
      tone: 'danger',
      confirmLabel: tc('actions.delete'),
    })
    if (!ok) return
    const result = await deleteSetupRow('hrm-review-template-sections', section.id, copy)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('sectionDeleted'))
    dirtyRef.current = false
    setSelection({ type: 'template' })
    router.refresh()
  }

  async function removeQuestion(question: ReviewQuestionNode) {
    const ok = await confirmDialog({
      title: t('deleteQuestionTitle'),
      message: t('deleteQuestion', { prompt: question.prompt }),
      tone: 'danger',
      confirmLabel: tc('actions.delete'),
    })
    if (!ok) return
    const result = await deleteSetupRow('hrm-review-template-questions', question.id, copy)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('questionDeleted'))
    dirtyRef.current = false
    setSelection({ type: 'section', id: question.sectionId })
    router.refresh()
  }

  async function removeTemplate() {
    const ok = await confirmDialog({
      title: t('deleteTemplateTitle'),
      message: t('deleteTemplate', { name: template.name }),
      tone: 'danger',
      confirmLabel: tc('actions.delete'),
    })
    if (!ok) return
    const result = await deleteSetupRow('hrm-review-templates', template.id, copy)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('templateDeleted'))
    router.push(basePath)
    router.refresh()
  }

  function moveSectionBy(section: ReviewSectionNode, delta: -1 | 1) {
    const index = sections.indexOf(section)
    const next = moveItem(sections, index, index + delta)
    if (next !== sections) void persistOrder(next)
  }

  function moveQuestionBy(question: ReviewQuestionNode, delta: -1 | 1) {
    const section = sections.find((entry) => entry.id === question.sectionId)
    if (!section) return
    const index = section.questions.findIndex((entry) => entry.id === question.id)
    const next = moveQuestion(sections, question.id, section.id, index + delta)
    if (next !== sections) void persistOrder(next)
  }

  function dropOnSection(target: ReviewSectionNode, dragged: DragItem, place: DropPlace) {
    if (dragged.type === 'section') {
      const from = sections.findIndex((section) => section.id === dragged.id)
      let to = sections.indexOf(target) + (place === 'after' ? 1 : 0)
      if (from < to) to -= 1
      const next = moveItem(sections, from, to)
      if (next !== sections) void persistOrder(next)
      return
    }
    // A question dropped on a section header lands at the top of that section.
    const next = moveQuestion(sections, dragged.id, target.id, 0)
    if (next !== sections) void persistOrder(next)
  }

  function dropOnQuestion(target: ReviewQuestionNode, dragged: DragItem, place: DropPlace) {
    const section = sections.find((entry) => entry.id === target.sectionId)
    if (!section) return
    const targetIndex = section.questions.findIndex((entry) => entry.id === target.id)
    const fromIndex = section.questions.findIndex((entry) => entry.id === dragged.id)
    let to = targetIndex + (place === 'after' ? 1 : 0)
    if (fromIndex !== -1 && fromIndex < to) to -= 1
    const next = moveQuestion(sections, dragged.id, section.id, to)
    if (next !== sections) void persistOrder(next)
  }

  function openSectionMenu(section: ReviewSectionNode, anchor: HTMLElement) {
    const index = sections.indexOf(section)
    setMenuItems([
      { key: 'add', label: t('addQuestion'), icon: Plus, onSelect: () => void addQuestion(section) },
      { key: 'sep', separator: true },
      { key: 'up', label: tb('moveUp'), icon: ArrowUp, disabled: index === 0 || reordering, onSelect: () => moveSectionBy(section, -1) },
      { key: 'down', label: tb('moveDown'), icon: ArrowDown, disabled: index === sections.length - 1 || reordering, onSelect: () => moveSectionBy(section, 1) },
      { key: 'sep2', separator: true },
      { key: 'delete', label: t('deleteSectionTitle'), icon: Trash2, danger: true, onSelect: () => void removeSection(section) },
    ])
    menu.openBelow(anchor)
  }

  function openQuestionMenu(question: ReviewQuestionNode, anchor: HTMLElement) {
    const section = sections.find((entry) => entry.id === question.sectionId)
    const index = section ? section.questions.findIndex((entry) => entry.id === question.id) : -1
    setMenuItems([
      { key: 'up', label: tb('moveUp'), icon: ArrowUp, disabled: index <= 0 || reordering, onSelect: () => moveQuestionBy(question, -1) },
      {
        key: 'down', label: tb('moveDown'), icon: ArrowDown,
        disabled: !section || index === section.questions.length - 1 || reordering,
        onSelect: () => moveQuestionBy(question, 1),
      },
      { key: 'sep', separator: true },
      { key: 'delete', label: t('deleteQuestionTitle'), icon: Trash2, danger: true, onSelect: () => void removeQuestion(question) },
    ])
    menu.openBelow(anchor)
  }

  const answerLabel = (kind: ReviewAnswerKind) => t(`answerKinds.${ANSWER_KIND_KEY[kind]}.label`)
  const sectionKindLabel = (kind: ReviewSectionKind) => t(`sectionKinds.${SECTION_KIND_KEY[kind]}.label`)
  const weightShare = (weight: string | null) =>
    weight && weightTotal > 0 ? Math.round((Number(weight) / weightTotal) * 100) : null

  const issueList = issues.map((entry, index) => {
    const section = entry.sectionId ? sections.find((candidate) => candidate.id === entry.sectionId) : undefined
    return {
      key: `${entry.issue}-${entry.sectionId ?? index}`,
      tone: entry.issue === 'emptySection' ? ('info' as const) : ('warning' as const),
      message: t(`issues.${entry.issue}`, { section: section?.title ?? '' }),
      onSelect: section ? () => void select({ type: 'section', id: section.id }) : entry.issue === 'inactive' ? () => void select({ type: 'template' }) : undefined,
    }
  })

  const outline = (
    <OutlinePanel
      title={t('outline')}
      actions={
        <Button type="button" size="icon" variant="ghost" aria-label={t('addSection')} title={t('addSection')} onClick={() => void addSection()}>
          <Plus size={15} />
        </Button>
      }
      footer={
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => void addSection()}>
          <Plus size={14} /> {t('addSection')}
        </Button>
      }
    >
      <OutlineRow
        selected={effective.type === 'template'}
        icon={<Settings2 size={15} />}
        label={t('templateSettings')}
        meta={t('scaleSummary', { min: template.scaleMin, max: template.scaleMax })}
        onSelect={() => void select({ type: 'template' })}
      />
      <div className="my-1.5 border-t border-slate-100 dark:border-slate-800" />
      {sections.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t('noSections')}</p>
      ) : (
        <div className="space-y-1">
          {sections.map((section) => {
            const SectionIcon = SECTION_ICON[section.kind]
            const share = weightShare(section.weight)
            const groupDrag = drag.bind(`group:${section.id}`, null, {
              canDrop: (dragged) => dragged.type === 'section',
              onDrop: (dragged, place) => dropOnSection(section, dragged, place),
            })
            const groupPlace = drag.dropPlace(`group:${section.id}`)
            return (
              <div key={section.id} {...groupDrag} className="relative rounded-md">
                {groupPlace ? (
                  <span
                    aria-hidden
                    className={cn(
                      'pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-teal-500',
                      groupPlace === 'before' ? '-top-0.5' : '-bottom-0.5',
                    )}
                  />
                ) : null}
                <OutlineRow
                  selected={effective.type === 'section' && effective.id === section.id}
                  icon={<SectionIcon size={15} />}
                  label={section.title}
                  meta={[
                    sectionKindLabel(section.kind),
                    t('questionCount', { count: section.questions.length }),
                    share !== null ? t('weightShare', { share }) : null,
                  ].filter(Boolean).join(' · ')}
                  onSelect={() => void select({ type: 'section', id: section.id })}
                  onMenu={(anchor) => openSectionMenu(section, anchor)}
                  menuLabel={tb('rowActions')}
                  grabLabel={tb('dragToReorder')}
                  drag={drag.bind(`section:${section.id}`, { key: `section:${section.id}`, type: 'section', id: section.id }, {
                    canDrop: (dragged) => dragged.type === 'question',
                    onDrop: (dragged, place) => dropOnSection(section, dragged, place),
                  })}
                  dropPlace={drag.dropPlace(`section:${section.id}`) ? 'after' : null}
                  dimmed={drag.dragging?.key === `section:${section.id}`}
                />
                {section.questions.map((question) => {
                  const AnswerIcon = ANSWER_ICON[question.answerKind]
                  return (
                    <OutlineRow
                      key={question.id}
                      depth={1}
                      selected={effective.type === 'question' && effective.id === question.id}
                      icon={<AnswerIcon size={14} />}
                      label={question.prompt}
                      meta={question.required ? `${answerLabel(question.answerKind)} · ${t('required')}` : answerLabel(question.answerKind)}
                      onSelect={() => void select({ type: 'question', id: question.id })}
                      onMenu={(anchor) => openQuestionMenu(question, anchor)}
                      menuLabel={tb('rowActions')}
                      grabLabel={tb('dragToReorder')}
                      drag={drag.bind(`question:${question.id}`, { key: `question:${question.id}`, type: 'question', id: question.id }, {
                        canDrop: (dragged) => dragged.type === 'question',
                        onDrop: (dragged, place) => dropOnQuestion(question, dragged, place),
                      })}
                      dropPlace={drag.dropPlace(`question:${question.id}`)}
                      dimmed={drag.dragging?.key === `question:${question.id}`}
                    />
                  )
                })}
                <button
                  type="button"
                  onClick={() => void addQuestion(section)}
                  className="ml-7 flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-teal-300"
                >
                  <Plus size={12} /> {t('addQuestion')}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </OutlinePanel>
  )

  let inspector: ReactNode
  if (effective.type === 'section' && selectedSection) {
    inspector = (
      <SectionInspector
        key={`${selectedSection.id}:${selectedSection.title}:${selectedSection.kind}:${selectedSection.weight}:${selectedSection.competencyId}`}
        section={selectedSection}
        competencies={competencies}
        share={weightShare(selectedSection.weight)}
        copy={copy}
        onDirty={reportDirty}
        onSaved={() => {
          dirtyRef.current = false
          router.refresh()
        }}
        onDelete={() => void removeSection(selectedSection)}
        onAddQuestion={() => void addQuestion(selectedSection)}
      />
    )
  } else if (effective.type === 'question' && selectedQuestion) {
    const parent = sections.find((section) => section.id === selectedQuestion.sectionId)
    inspector = (
      <QuestionInspector
        key={`${selectedQuestion.id}:${selectedQuestion.prompt}:${selectedQuestion.answerKind}:${selectedQuestion.required}`}
        question={selectedQuestion}
        sectionTitle={parent?.title ?? ''}
        scaleMin={template.scaleMin}
        scaleMax={template.scaleMax}
        copy={copy}
        onDirty={reportDirty}
        onSaved={() => {
          dirtyRef.current = false
          router.refresh()
        }}
        onDelete={() => void removeQuestion(selectedQuestion)}
      />
    )
  } else {
    inspector = (
      <TemplateInspector
        key={`${template.name}:${template.isActive}:${template.scaleMin}:${template.scaleMax}:${template.scaleLabels.join('|')}`}
        template={template}
        copy={copy}
        onDirty={reportDirty}
        onSaved={() => {
          dirtyRef.current = false
          router.refresh()
        }}
      />
    )
  }

  const headerActions = (
    <>
      {cycleHref ? (
        <Button
          type="button"
          disabled={!template.isActive || issues.length > 0 || reordering}
          onClick={async () => {
            if (dirtyRef.current && !(await confirmDialog({ message: tb('discardChanges'), tone: 'danger', confirmLabel: tb('discard') }))) return
            router.push(cycleHref)
          }}
        >
          {th('performance.newCycle')}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={template.cycleCount > 0}
        title={template.cycleCount > 0 ? t('deleteBlocked') : undefined}
        onClick={() => void removeTemplate()}
      >
        <Trash2 size={14} /> {tc('actions.delete')}
      </Button>
    </>
  )
  const badges = (
    <>
      <Badge variant={template.isActive ? 'success' : 'secondary'}>{template.isActive ? tb('active') : tb('inactive')}</Badge>
      {template.cycleCount > 0 ? <Badge variant="outline">{t('cycleCount', { count: template.cycleCount })}</Badge> : null}
    </>
  )
  const status = reordering ? <span className="text-xs text-slate-500 dark:text-slate-400">{tc('actions.saving')}</span> : null
  const inPerformance = basePath === '/hrm/performance/templates'
  const header = inPerformance ? (
    <PageHeader
      title={template.name}
      titleContent={<span className="flex flex-wrap items-center gap-2">{template.name}{badges}</span>}
      back={{ href: basePath, label: th('performance.workspace.reviewFormsTab') }}
      actions={<>{status}{headerActions}</>}
    />
  ) : (
    <BuilderHeader backHref={basePath} backLabel={t('backToTemplates')} title={template.name} badges={badges} status={status} actions={headerActions} />
  )
  const content = (
    <div>
      <BuilderSplit outline={outline}>
        <BuilderIssues issues={issueList} />
        {inspector}
        <FormPreview
          template={templateView}
          selection={effective}
          onSelect={(next) => void select(next)}
          sectionKindLabel={sectionKindLabel}
          weightShare={weightShare}
        />
      </BuilderSplit>
      <ContextMenu open={menu.open} position={menu.position} items={menuItems} onClose={menu.close} />
    </div>
  )
  return inPerformance ? <ListPageLayout header={header}>{content}</ListPageLayout> : <div>{header}{content}</div>
}

function TemplateInspector({
  template,
  copy,
  onDirty,
  onSaved,
}: {
  template: ReviewTemplateNode
  copy: BuilderErrorCopy
  onDirty: (dirty: boolean) => void
  onSaved: () => void
}) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const tb = useTranslations('admin.setup.builder')
  const initial = { name: template.name, isActive: template.isActive, scaleMin: template.scaleMin, scaleMax: template.scaleMax, scaleLabels: template.scaleLabels }
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useDirtyReport(dirty, onDirty)

  async function save() {
    if (!draft.name.trim()) {
      setError(t('errors.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const result = await updateSetupRow('hrm-review-templates', template.id, {
      name: draft.name.trim(),
      isActive: draft.isActive,
      ratingScaleMin: draft.scaleMin.trim(),
      ratingScaleMax: draft.scaleMax.trim(),
      ratingScaleLabels: draft.scaleLabels,
    }, copy)
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
      eyebrow={t('templateSettings')}
      title={draft.name || template.name}
      error={error}
      footer={<InspectorFooter dirty={dirty} busy={busy} onDiscard={() => { setDraft(initial); setError(null) }} onSave={() => void save()} />}
    >
      <div className="space-y-1.5">
        <Label htmlFor="review-template-name">{t('fields.name')}</Label>
        <Input id="review-template-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{tb('active')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('help.active')}</p>
        </div>
        <Switch on={draft.isActive} disabled={busy} label={tb('active')} onToggle={() => setDraft({ ...draft, isActive: !draft.isActive })} />
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('ratingScale')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="review-scale-min" help={t('help.scaleMin')}>{t('fields.scaleMin')}</Label>
            <Input id="review-scale-min" inputMode="decimal" value={draft.scaleMin} onChange={(event) => setDraft({ ...draft, scaleMin: event.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="review-scale-max" help={t('help.scaleMax')}>{t('fields.scaleMax')}</Label>
            <Input id="review-scale-max" inputMode="decimal" value={draft.scaleMax} onChange={(event) => setDraft({ ...draft, scaleMax: event.target.value })} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="review-scale-labels" help={t('help.scaleLabels')}>{t('fields.scaleLabels')}</Label>
          <TagInput
            id="review-scale-labels"
            value={draft.scaleLabels}
            onChange={(scaleLabels) => setDraft({ ...draft, scaleLabels })}
            placeholder={t('scaleLabelsPlaceholder')}
            ariaLabel={t('fields.scaleLabels')}
            allowNew
          />
        </div>
        <ScaleStrip min={draft.scaleMin} max={draft.scaleMax} labels={draft.scaleLabels} />
      </fieldset>
      {template.cycleCount > 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          {t('help.historyPinned', { count: template.cycleCount })}
        </p>
      ) : null}
    </InspectorPanel>
  )
}

function SectionInspector({
  section,
  competencies,
  share,
  copy,
  onDirty,
  onSaved,
  onDelete,
  onAddQuestion,
}: {
  section: ReviewSectionNode
  competencies: CompetencyChoice[] | null
  share: number | null
  copy: BuilderErrorCopy
  onDirty: (dirty: boolean) => void
  onSaved: () => void
  onDelete: () => void
  onAddQuestion: () => void
}) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const initial = { title: section.title, kind: section.kind, weight: section.weight ?? '', competencyId: section.competencyId ?? '' }
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useDirtyReport(dirty, onDirty)
  const Icon = SECTION_ICON[draft.kind]

  async function save() {
    if (!draft.title.trim()) {
      setError(t('errors.titleRequired'))
      return
    }
    const weight = decimalOrNull(draft.weight)
    if (Number.isNaN(weight) || (weight !== null && weight < 0)) {
      setError(t('errors.weightInvalid'))
      return
    }
    setBusy(true)
    setError(null)
    const fields = draft.title !== initial.title || draft.kind !== initial.kind || draft.weight !== initial.weight
    if (fields) {
      const result = await updateSetupRow('hrm-review-template-sections', section.id, {
        title: draft.title.trim(),
        kind: draft.kind,
        weight: draft.weight.trim() === '' ? null : draft.weight.trim(),
      }, copy)
      if (!result.ok) {
        setBusy(false)
        setError(result.error)
        toast.error(result.error)
        return
      }
    }
    if (draft.competencyId !== initial.competencyId) {
      const result = await postJson('/api/hrm/competency-links', {
        action: 'attachSection',
        sectionId: section.id,
        competencyId: draft.competencyId || null,
      }, copy)
      if (!result.ok) {
        setBusy(false)
        setError(result.error)
        toast.error(result.error)
        if (fields) onSaved()
        return
      }
    }
    setBusy(false)
    toast.success(tb('saved'))
    onSaved()
  }

  const kindOptions = REVIEW_SECTION_KINDS.map((kind) => {
    const KindIcon = SECTION_ICON[kind]
    return {
      value: kind,
      label: t(`sectionKinds.${SECTION_KIND_KEY[kind]}.label`),
      description: t(`sectionKinds.${SECTION_KIND_KEY[kind]}.description`),
      icon: <KindIcon size={16} />,
    }
  })

  return (
    <InspectorPanel
      icon={<Icon size={18} />}
      eyebrow={t('section')}
      title={draft.title || section.title}
      error={error}
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={onAddQuestion}>
          <Plus size={14} /> {t('addQuestion')}
        </Button>
      }
      footer={
        <InspectorFooter
          dirty={dirty}
          busy={busy}
          onDiscard={() => { setDraft(initial); setError(null) }}
          onSave={() => void save()}
          extra={
            <Button type="button" variant="ghost" size="sm" className="text-red-600 hover:text-red-700 dark:text-red-400" onClick={onDelete}>
              <Trash2 size={14} /> {tc('actions.delete')}
            </Button>
          }
        />
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="review-section-title">{t('fields.sectionTitle')}</Label>
        <Input id="review-section-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label>{t('fields.sectionKind')}</Label>
        <ChoiceCards ariaLabel={t('fields.sectionKind')} value={draft.kind} options={kindOptions} onChange={(kind) => setDraft({ ...draft, kind })} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="review-section-weight" help={t('help.weight')}>{t('fields.weight')}</Label>
          <Input
            id="review-section-weight"
            inputMode="decimal"
            value={draft.weight}
            placeholder={t('weightPlaceholder')}
            onChange={(event) => setDraft({ ...draft, weight: event.target.value })}
          />
          {share !== null && !dirty ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('weightShareLong', { share })}</p> : null}
        </div>
        {competencies !== null && draft.kind === 'competency' ? (
          <div className="space-y-1.5">
            <Label help={t('help.competency')}>{t('fields.competency')}</Label>
            <SearchSelect
              value={draft.competencyId}
              onChange={(competencyId) => setDraft({ ...draft, competencyId })}
              options={competencies.map((competency) => ({ value: competency.id, label: competency.label, group: competency.framework }))}
              placeholder={t('competencyPlaceholder')}
              clearable
              searchable
              ariaLabel={t('fields.competency')}
            />
          </div>
        ) : null}
      </div>
      {draft.kind === 'goals' ? (
        <p className="rounded-lg bg-sky-50 px-3 py-2.5 text-xs text-sky-900 dark:bg-sky-950/30 dark:text-sky-200">{t('help.goalsSection')}</p>
      ) : null}
    </InspectorPanel>
  )
}

function QuestionInspector({
  question,
  sectionTitle,
  scaleMin,
  scaleMax,
  copy,
  onDirty,
  onSaved,
  onDelete,
}: {
  question: ReviewQuestionNode
  sectionTitle: string
  scaleMin: string
  scaleMax: string
  copy: BuilderErrorCopy
  onDirty: (dirty: boolean) => void
  onSaved: () => void
  onDelete: () => void
}) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  const initial = { prompt: question.prompt, answerKind: question.answerKind, required: question.required }
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useDirtyReport(dirty, onDirty)
  const Icon = ANSWER_ICON[draft.answerKind]

  async function save() {
    if (!draft.prompt.trim()) {
      setError(t('errors.promptRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const result = await updateSetupRow('hrm-review-template-questions', question.id, {
      prompt: draft.prompt.trim(),
      answerKind: draft.answerKind,
      required: draft.required,
    }, copy)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      toast.error(result.error)
      return
    }
    toast.success(tb('saved'))
    onSaved()
  }

  const answerOptions = REVIEW_ANSWER_KINDS.map((kind) => {
    const KindIcon = ANSWER_ICON[kind]
    return {
      value: kind,
      label: t(`answerKinds.${ANSWER_KIND_KEY[kind]}.label`),
      description: t(`answerKinds.${ANSWER_KIND_KEY[kind]}.description`, { min: scaleMin, max: scaleMax }),
      icon: <KindIcon size={16} />,
    }
  })

  return (
    <InspectorPanel
      icon={<Icon size={18} />}
      eyebrow={t('questionIn', { section: sectionTitle })}
      title={draft.prompt || question.prompt}
      error={error}
      footer={
        <InspectorFooter
          dirty={dirty}
          busy={busy}
          onDiscard={() => { setDraft(initial); setError(null) }}
          onSave={() => void save()}
          extra={
            <Button type="button" variant="ghost" size="sm" className="text-red-600 hover:text-red-700 dark:text-red-400" onClick={onDelete}>
              <Trash2 size={14} /> {tc('actions.delete')}
            </Button>
          }
        />
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="review-question-prompt">{t('fields.prompt')}</Label>
        <Textarea id="review-question-prompt" rows={3} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label>{t('fields.answerKind')}</Label>
        <ChoiceCards ariaLabel={t('fields.answerKind')} value={draft.answerKind} options={answerOptions} onChange={(answerKind) => setDraft({ ...draft, answerKind })} />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('fields.required')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('help.required')}</p>
        </div>
        <Switch on={draft.required} disabled={busy} label={t('fields.required')} onToggle={() => setDraft({ ...draft, required: !draft.required })} />
      </div>
    </InspectorPanel>
  )
}

/** The rating points a reviewer picks from, with the declared labels under them. */
function ScaleStrip({ min, max, labels }: { min: string; max: string; labels: string[] }) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const low = Number(min)
  const high = Number(max)
  const points =
    Number.isInteger(low) && Number.isInteger(high) && high > low && high - low <= 10
      ? Array.from({ length: high - low + 1 }, (_, index) => low + index)
      : null
  if (!points) {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {Number.isFinite(low) && Number.isFinite(high) && high > low ? t('scaleRange', { min, max }) : t('scaleInvalid')}
      </p>
    )
  }
  const perPoint = labels.length === points.length
  return (
    <div>
      <div className="flex gap-1.5">
        {points.map((point, index) => (
          <div key={point} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="flex h-8 w-full items-center justify-center rounded-md border border-slate-200 bg-white text-sm font-medium text-slate-700 tabular-nums dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              {point}
            </span>
            {perPoint ? <span className="w-full truncate text-center text-[11px] text-slate-500 dark:text-slate-400">{labels[index]}</span> : null}
          </div>
        ))}
      </div>
      {!perPoint && labels.length > 0 ? (
        <div className="mt-1 flex justify-between gap-3 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="truncate">{labels[0]}</span>
          {labels.length > 1 ? <span className="truncate text-right">{labels[labels.length - 1]}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Live preview of the form reviewers fill in; clicking a block selects it in the outline. */
function FormPreview({
  template,
  selection,
  onSelect,
  sectionKindLabel,
  weightShare,
}: {
  template: ReviewTemplateNode
  selection: Selection
  onSelect: (selection: Selection) => void
  sectionKindLabel: (kind: ReviewSectionKind) => string
  weightShare: (weight: string | null) => number | null
}) {
  const t = useTranslations('admin.setup.reviewBuilder')
  const numbers = new Map(template.sections.flatMap((section) => section.questions).map((question, index) => [question.id, index + 1]))
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        <Eye size={15} className="text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('preview.title')}</h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">{t('preview.subtitle')}</span>
      </div>
      <div className="bg-slate-100/70 p-4 sm:p-6 dark:bg-slate-950/40">
        <div className="mx-auto max-w-2xl space-y-6 rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <div>
            <p className="text-xs font-medium tracking-wide text-slate-400 uppercase">{t('preview.eyebrow')}</p>
            <h4 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{template.name}</h4>
          </div>
          {template.sections.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              <ClipboardList size={20} className="mx-auto mb-2 text-slate-300" />
              {t('preview.empty')}
            </div>
          ) : null}
          {template.sections.map((section) => {
            const share = weightShare(section.weight)
            const sectionSelected = selection.type === 'section' && selection.id === section.id
            return (
              <section key={section.id} className="space-y-3">
                <button
                  type="button"
                  onClick={() => onSelect({ type: 'section', id: section.id })}
                  className={cn(
                    '-mx-2 flex w-[calc(100%+1rem)] items-baseline justify-between gap-3 rounded-md px-2 py-1 text-left',
                    sectionSelected ? 'bg-teal-50 ring-1 ring-teal-200 dark:bg-teal-950/40 dark:ring-teal-900' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                  )}
                >
                  <span className="text-base font-semibold text-slate-900 dark:text-slate-100">{section.title}</span>
                  <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                    {sectionKindLabel(section.kind)}
                    {share !== null ? ` · ${t('weightShare', { share })}` : ''}
                  </span>
                </button>
                {section.kind === 'goals' ? (
                  <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">{t('preview.goalsNote')}</p>
                ) : null}
                {section.questions.map((question) => {
                  const selected = selection.type === 'question' && selection.id === question.id
                  const rating = question.answerKind !== 'text'
                  const text = question.answerKind !== 'rating'
                  return (
                    <button
                      key={question.id}
                      type="button"
                      onClick={() => onSelect({ type: 'question', id: question.id })}
                      className={cn(
                        '-mx-2 block w-[calc(100%+1rem)] space-y-2 rounded-md px-2 py-2 text-left',
                        selected ? 'bg-teal-50 ring-1 ring-teal-200 dark:bg-teal-950/40 dark:ring-teal-900' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                      )}
                    >
                      <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                        <span className="mr-1.5 text-slate-400 tabular-nums">{numbers.get(question.id)}.</span>
                        {question.prompt}
                        {question.required ? <span className="ml-1 text-red-500" aria-label={t('required')}>*</span> : null}
                      </span>
                      {rating ? (
                        <span className="block">
                          <ScaleStrip min={template.scaleMin} max={template.scaleMax} labels={template.scaleLabels} />
                        </span>
                      ) : null}
                      {text ? (
                        <span className="block h-16 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-400 dark:border-slate-700 dark:bg-slate-800/40">
                          {t('preview.textPlaceholder')}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </section>
            )
          })}
        </div>
      </div>
    </Card>
  )
}
