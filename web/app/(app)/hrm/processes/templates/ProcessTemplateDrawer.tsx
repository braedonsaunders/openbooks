'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  ClipboardList,
  Plus,
  Settings2,
  Eye,
  Copy,
  Trash2,
  UserRound,
  Check,
  Paperclip,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import {
  Badge,
  Button,
  Input,
  Label,
  SearchSelect,
  Textarea,
  ContextMenu,
  useContextMenu,
  type ContextMenuEntry,
} from '@openbooks/ui'
import {
  checklistDocumentSchema,
  checklistIssues,
  emptyStepDesign,
  type ChecklistDocument,
  type ChecklistStep,
  type FormField,
  type FieldType,
  type FlowSubjectProfile,
} from '@openbooks/forms-core'
import type { ChecklistDesignerValue } from '@openbooks/engine/hrm/processes'
import {
  BuilderSplit,
  OutlinePanel,
  OutlineRow,
  InspectorPanel,
  ChoiceCards,
  BuilderIssues,
  useOutlineDrag,
} from '../../../../../components/builder/builder-kit'
import { DirtyUrlDrawer, useDirtyUrlDrawer } from '../../../../../components/dirty-url-drawer'
import { ChecklistStepContent } from '../../../../../components/checklist-step-content'
import { LogicRuleBuilder } from '../../../admin/flows/_builder/LogicRuleBuilder'
import { AddFieldButton, FieldRow } from '../../../records/types/TypeBuilderDrawer'
import { readApiErrorMessage } from '../../../../../lib/api-error'
import { confirmDialog } from '../../../../../lib/confirm'
import { promptDialog } from '../../../../../lib/prompt'

type Option = { value: string; label: string }
export type ProcessTemplateEditorValue = ChecklistDesignerValue
const scope = { employerSubsidiaryId: null, departmentId: null }
const freshStep = (title = '', section = ''): ChecklistStep => ({
  id: crypto.randomUUID(),
  title,
  description: null,
  ownerKind: 'manager',
  ownerPartyId: null,
  dueOffsetDays: 0,
  required: true,
  evidenceKind: 'none',
  design: { ...emptyStepDesign(), section },
})
const STARTERS = [
  {
    key: 'newHire',
    kind: 'onboarding',
    sections: [
      ['beforeArrival', ['prepareWorkspace', 'prepareAccounts']],
      ['firstDay', ['welcomeEmployee', 'reviewPolicies']],
      ['firstWeek', ['teamIntroduction', 'firstCheckIn']],
    ],
  },
  {
    key: 'remoteHire',
    kind: 'onboarding',
    sections: [
      ['beforeArrival', ['shipEquipment', 'prepareAccounts']],
      ['firstDay', ['welcomeEmployee', 'reviewPolicies']],
      ['firstWeek', ['teamIntroduction', 'firstCheckIn']],
    ],
  },
  {
    key: 'departure',
    kind: 'offboarding',
    sections: [
      ['handover', ['planHandover', 'transferKnowledge']],
      ['lastDay', ['returnEquipment', 'reviewAccess', 'exitConversation']],
    ],
  },
  {
    key: 'transfer',
    kind: 'transfer',
    sections: [
      ['beforeTransition', ['confirmRole', 'planHandover']],
      ['transitionDay', ['updateAccess', 'teamIntroduction']],
      ['followUp', ['firstCheckIn']],
    ],
  },
  {
    key: 'contractor',
    kind: 'onboarding',
    sections: [
      ['beforeArrival', ['confirmEngagement', 'prepareAccounts']],
      ['firstDay', ['reviewPolicies', 'teamIntroduction']],
    ],
  },
  { key: 'blank', kind: 'onboarding', sections: [] },
] as const

export function ProcessTemplateDrawer(props: {
  template: ProcessTemplateEditorValue | null
  creating: boolean
  closeHref: string
  subsidiaries: Option[]
  departments: Option[]
  employees: Option[]
  employments?: Option[]
}) {
  const t = useTranslations('hrm.processes.designer')
  return (
    <DirtyUrlDrawer
      open
      closeHref={props.closeHref}
      size="2xl"
      title={t('title')}
      description={t('subtitle')}
    >
      <ChecklistDesigner {...props} />
    </DirtyUrlDrawer>
  )
}

function ChecklistDesigner({
  template,
  subsidiaries,
  departments,
  employees,
  employments = [],
}: Parameters<typeof ProcessTemplateDrawer>[0]) {
  const t = useTranslations('hrm.processes.designer')
  const router = useRouter()
  const [document, setDocument] = useState<ChecklistDocument>(
    () => template?.document ?? { name: '', kind: 'onboarding', appliesTo: scope, steps: [] },
  )
  const [selection, setSelection] = useState<string>(template?.document.steps[0]?.id ?? 'settings')
  const [starter, setStarter] = useState(!template)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(template ? JSON.stringify(template.document) : '')
  const savedRef = useRef(saved)
  const [versions, setVersions] = useState(template?.versions ?? [])
  const [active, setActive] = useState(template?.isActive ?? false)
  const [publishedRevision, setPublishedRevision] = useState(
    template?.publishedRevision ?? template?.revision ?? 0,
  )
  const [version, setVersion] = useState(template?.publishedVersion ?? 0)
  const [expandedField, setExpandedField] = useState<string | null>(null)
  const [sampleDate, setSampleDate] = useState('')
  const [sampleEmployment, setSampleEmployment] = useState('')
  const [coverage, setCoverage] = useState<{
    steps: { id: string; title: string; dueOn: string }[]
  } | null>(null)
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>({})
  const id = useRef(template?.id ?? null)
  const revision = useRef(template?.revision ?? 0)
  const documentRef = useRef(document)
  documentRef.current = document
  const pending = useRef<Promise<boolean> | null>(null)
  const mounted = useRef(true)
  const dirty = JSON.stringify(document) !== saved && !starter
  useDirtyUrlDrawer(dirty, busy)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const menu = useContextMenu()
  const [menuItems, setMenuItems] = useState<ContextMenuEntry[]>([])
  const drag = useOutlineDrag<{ key: string }>()
  const selected = document.steps.find((s) => s.id === selection)
  const issues = checklistIssues(document)
  function edit(patch: Partial<ChecklistDocument>) {
    setDocument((d) => ({ ...d, ...patch }))
    setCoverage(null)
  }
  function editStep(patch: Partial<ChecklistStep>) {
    setDocument((d) => ({
      ...d,
      steps: d.steps.map((s) => (s.id === selection ? { ...s, ...patch } : s)),
    }))
    setCoverage(null)
  }
  function editDesign(patch: Partial<ChecklistStep['design']>) {
    if (selected) editStep({ design: { ...selected.design, ...patch } })
  }
  function addStep(title = '') {
    const s = freshStep(title, selected?.design.section ?? '')
    setDocument((d) => ({ ...d, steps: [...d.steps, s] }))
    setSelection(s.id)
    setPreview(false)
  }
  function move(stepId: string, target: number) {
    if (publishing) return
    setDocument((d) => {
      const steps = [...d.steps],
        from = steps.findIndex((s) => s.id === stepId)
      if (from < 0 || target < 0 || target >= steps.length) return d
      const [s] = steps.splice(from, 1)
      steps.splice(target, 0, s!)
      return { ...d, steps }
    })
  }
  async function request(body: unknown) {
    const response = await fetch('/api/hrm/process-templates/designer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(await readApiErrorMessage(response, t('saveFailed')))
    return response.json()
  }
  const save = useCallback(async (): Promise<boolean> => {
    if (pending.current) {
      if (!(await pending.current)) return false
      return save()
    }
    const next = documentRef.current,
      fingerprint = JSON.stringify(next)
    const parsed = checklistDocumentSchema.safeParse(next)
    if (!parsed.success) {
      setError(
        checklistIssues(next).find((i) => /whole number/.test(i.message))?.message ??
          t('invalidDraft', {
            field: parsed.error.issues[0]?.path.join('.') ?? '',
            message: parsed.error.issues[0]?.message ?? '',
          }),
      )
      return false
    }
    if (!next.name.trim()) {
      setError(t('nameRequired'))
      return false
    }
    if (fingerprint === savedRef.current) return true
    id.current ??= crypto.randomUUID()
    setBusy(true)
    setError(null)
    const work = (async () => {
      try {
        const result = (await request({
          action: 'save',
          templateId: id.current,
          revision: revision.current,
          document: next,
        })) as ChecklistDesignerValue
        revision.current = result.revision
        savedRef.current = fingerprint
        if (mounted.current) setSaved(fingerprint)
        return true
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : t('saveFailed'))
        return false
      } finally {
        pending.current = null
        if (mounted.current) setBusy(false)
      }
    })()
    pending.current = work
    return work
  }, [saved, t])
  useEffect(() => {
    if (!dirty || !document.name.trim() || busy || error) return
    const timer = setTimeout(() => {
      void save()
    }, 1200)
    return () => clearTimeout(timer)
  }, [dirty, document, busy, error, save])
  async function publish() {
    if (!(await save())) return
    const reason = await promptDialog({
      title: t('publish'),
      message: t('publishReason'),
      label: t('reason'),
      confirmLabel: t('publish'),
    })
    if (!reason?.trim()) return
    setPublishing(true)
    if (!(await save())) {
      setPublishing(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = (await request({
        action: 'publish',
        templateId: id.current,
        revision: revision.current,
        reason,
      })) as ChecklistDesignerValue
      setPublishedRevision(result.publishedRevision ?? publishedRevision)
      setActive(result.isActive)
      setVersion(result.publishedVersion)
      setVersions(
        result.versions ?? [
          ...versions,
          { version: result.publishedVersion, publishedAt: '', publishedBy: '', reason },
        ],
      )
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
      setPublishing(false)
    }
  }
  async function retire() {
    if (!(await save())) return
    const reason = await promptDialog({
      title: t('retire'),
      message: t('retireHelp'),
      label: t('reason'),
      confirmLabel: t('retire'),
    })
    if (!reason?.trim()) return
    setPublishing(true)
    if (!(await save())) {
      setPublishing(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = (await request({
        action: 'retire',
        templateId: id.current,
        revision: revision.current,
        reason,
      })) as ChecklistDesignerValue
      setPublishedRevision(result.publishedRevision ?? publishedRevision)
      setActive(result.isActive)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
      setPublishing(false)
    }
  }
  async function reload() {
    if (
      !id.current ||
      (dirty &&
        !(await confirmDialog({
          message: t('reloadHelp'),
          confirmLabel: t('reload'),
          tone: 'danger',
        })))
    )
      return
    setBusy(true)
    setError(null)
    try {
      const result = (await request({
        action: 'load',
        templateId: id.current,
      })) as ChecklistDesignerValue
      setDocument(result.document)
      documentRef.current = result.document
      savedRef.current = JSON.stringify(result.document)
      setSaved(savedRef.current)
      revision.current = result.revision
      setPublishedRevision(result.publishedRevision ?? publishedRevision)
      setActive(result.isActive)
      setVersion(result.publishedVersion)
      setVersions(result.versions ?? [])
      setSelection(result.document.steps[0]?.id ?? 'settings')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  async function restore(version: number) {
    if (
      !id.current ||
      !(await confirmDialog({ message: t('restoreHelp'), confirmLabel: t('restore') }))
    )
      return
    setBusy(true)
    setError(null)
    try {
      const previous = (await request({
        action: 'version',
        templateId: id.current,
        version,
      })) as ChecklistDocument
      setDocument(previous)
      setSelection('settings')
      setPreview(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  async function remove(step: ChecklistStep) {
    if (
      !(await confirmDialog({
        message: t('deleteConfirm', { title: step.title || t('untitled') }),
        confirmLabel: t('delete'),
        tone: 'danger',
      }))
    )
      return
    setDocument((d) => ({
      ...d,
      steps: d.steps
        .filter((s) => s.id !== step.id)
        .map((s) => ({
          ...s,
          design: { ...s.design, dependencies: s.design.dependencies.filter((x) => x !== step.id) },
        })),
    }))
    setSelection('settings')
  }
  async function paste() {
    const lines = await promptDialog({
      title: t('paste'),
      message: t('pasteHelp'),
      label: t('steps'),
      multiline: true,
      confirmLabel: t('add'),
    })
    if (!lines) return
    const steps = lines
      .split('\n')
      .map((x) => x.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, ''))
      .filter(Boolean)
      .map((x) => freshStep(x, selected?.design.section ?? ''))
    if (documentRef.current.steps.length + steps.length > 200) {
      setError(t('stepLimit'))
      return
    }
    setDocument((d) => ({ ...d, steps: [...d.steps, ...steps] }))
    if (steps[0]) setSelection(steps[0].id)
  }
  function duplicate(step: ChecklistStep) {
    const copy = {
      ...structuredClone(step),
      id: crypto.randomUUID(),
      title: t('copyTitle', { title: step.title }),
    }
    setDocument((d) => ({ ...d, steps: [...d.steps, copy] }))
    setSelection(copy.id)
  }
  const conditionProfile: FlowSubjectProfile = {
    subjectKind: 'checklist_context',
    label: t('coverage'),
    triggers: [],
    actions: [],
    statuses: [],
    fields: [
      { key: 'employerSubsidiaryId', label: t('employer'), type: 'enum', options: subsidiaries },
      { key: 'departmentId', label: t('department'), type: 'enum', options: departments },
      {
        key: 'kind',
        label: t('kind'),
        type: 'enum',
        options: ['onboarding', 'offboarding', 'transfer'].map((value) => ({
          value,
          label: t(value),
        })),
      },
    ],
  }
  function addField(type: FieldType) {
    if (!selected) return
    const field: FormField = {
      id: 'field_' + crypto.randomUUID().replaceAll('-', ''),
      type,
      label: t('newField'),
      required: true,
    }
    const form = selected.design.form ?? {
      schemaVersion: 1 as const,
      title: t('responseForm'),
      sections: [{ id: 'response', fields: [] }],
    }
    editDesign({
      form: {
        ...form,
        sections: form.sections.map((s, i) =>
          i === 0 ? { ...s, fields: [...s.fields, field] } : s,
        ),
      },
    })
    setExpandedField(field.id)
  }
  async function testCoverage() {
    setBusy(true)
    setError(null)
    try {
      setCoverage(
        await request({
          action: 'preview',
          document,
          employmentId: sampleEmployment,
          effectiveDate: sampleDate,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  if (starter)
    return (
      <InspectorPanel icon={<Sparkles size={20} />} eyebrow={t('start')} title={t('starterTitle')}>
        <p className="text-sm text-slate-500">{t('starterHelp')}</p>
        <ChoiceCards
          value=""
          ariaLabel={t('starterTitle')}
          columns={3}
          options={STARTERS.map((s) => ({
            value: s.key,
            label: t(`starters.${s.key}`),
            description: t(`starterHelpText.${s.key}`),
            icon: <ClipboardList size={20} />,
          }))}
          onChange={(key) => {
            const s = STARTERS.find((s) => s.key === key)!
            const steps = s.sections.flatMap(([section, titles]) =>
              titles.map((title) => ({
                ...freshStep(t(`starterSteps.${title}`), t(`starterSections.${section}`)),
                description: t(`starterGuidance.${title}`),
                ownerKind:
                  title === 'reviewPolicies'
                    ? ('employee' as const)
                    : ['prepareAccounts', 'reviewAccess', 'updateAccess'].includes(title)
                      ? ('hr' as const)
                      : ('manager' as const),
                evidenceKind:
                  title === 'reviewPolicies' ? ('acknowledgement' as const) : ('none' as const),
                dueOffsetDays: section === 'beforeArrival' ? -3 : section === 'firstWeek' ? 7 : 0,
              })),
            )
            setDocument({
              name: s.key === 'blank' ? '' : t(`starters.${s.key}`),
              kind: s.kind,
              appliesTo: scope,
              steps,
            })
            setSelection(steps[0]?.id ?? 'settings')
            setStarter(false)
          }}
        />
      </InspectorPanel>
    )
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            {version ? t('version', { version }) : active ? t('legacyActive') : t('draft')}
          </Badge>
          {active && revision.current > publishedRevision ? (
            <Badge variant="outline">{t('pendingChanges')}</Badge>
          ) : null}
          {version > 0 && !active ? <Badge variant="outline">{t('retired')}</Badge> : null}
          <span role="status" className="text-xs text-slate-500">
            {busy ? t('saving') : dirty ? t('unsaved') : t('saved')}
          </span>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button variant="outline" onClick={() => setPreview((v) => !v)}>
            <Eye size={15} />
            {preview ? t('edit') : t('preview')}
          </Button>
          <Button variant="outline" disabled={busy || !dirty} onClick={() => void save()}>
            {t('saveDraft')}
          </Button>
          <Button disabled={busy || issues.length > 0} onClick={() => void publish()}>
            <ShieldCheck size={15} />
            {t('publish')}
          </Button>
        </div>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
          <Button variant="ghost" size="sm" onClick={() => void save()}>
            {t('retry')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            {t('reload')}
          </Button>
        </p>
      ) : null}
      <fieldset disabled={publishing} className="min-w-0">
        <BuilderSplit
          outline={
            <div className="space-y-3">
              <OutlinePanel
                title={t('steps')}
                actions={<Badge variant="outline">{document.steps.length}</Badge>}
                footer={
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={document.steps.length >= 200}
                      onClick={() => addStep()}
                    >
                      <Plus size={14} />
                      {t('addStep')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void paste()}>
                      {t('paste')}
                    </Button>
                  </div>
                }
              >
                <OutlineRow
                  selected={selection === 'settings'}
                  icon={<Settings2 size={16} />}
                  label={t('settings')}
                  onSelect={() => setSelection('settings')}
                />
                {document.steps.map((s, i) => (
                  <div key={s.id}>
                    {s.design.section &&
                    (i === 0 || document.steps[i - 1]?.design.section !== s.design.section) ? (
                      <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase text-slate-400">
                        {s.design.section}
                      </p>
                    ) : null}
                    <OutlineRow
                      selected={selection === s.id}
                      icon={<span className="text-xs tabular-nums">{i + 1}</span>}
                      label={s.title}
                      placeholder={t('untitled')}
                      meta={t(s.ownerKind) + ' · ' + t('offset', { days: s.dueOffsetDays })}
                      onSelect={() => setSelection(s.id)}
                      menuLabel={t('stepMenu')}
                      onMenu={(anchor) => {
                        setMenuItems([
                          {
                            key: 'duplicate',
                            label: t('duplicate'),
                            icon: Copy,
                            onSelect: () => duplicate(s),
                          },
                          {
                            key: 'up',
                            label: t('moveUp'),
                            disabled: i === 0,
                            onSelect: () => move(s.id, i - 1),
                          },
                          {
                            key: 'down',
                            label: t('moveDown'),
                            disabled: i === document.steps.length - 1,
                            onSelect: () => move(s.id, i + 1),
                          },
                          {
                            key: 'delete',
                            label: t('delete'),
                            danger: true,
                            icon: Trash2,
                            onSelect: () => void remove(s),
                          },
                        ])
                        menu.openBelow(anchor)
                      }}
                      drag={drag.bind(
                        s.id,
                        { key: s.id },
                        {
                          canDrop: () => true,
                          onDrop: (from, place) => {
                            const fromIndex = document.steps.findIndex((s) => s.id === from.key)
                            const target = i + (place === 'after' ? 1 : 0) - (fromIndex < i ? 1 : 0)
                            move(from.key, Math.min(document.steps.length - 1, target))
                          },
                        },
                      )}
                      dropPlace={drag.dropPlace(s.id)}
                    />
                  </div>
                ))}
              </OutlinePanel>
              <BuilderIssues
                issues={issues.map((issue, i) => ({
                  key: String(i),
                  tone: 'warning',
                  message: issue.message,
                  onSelect: () => setSelection(issue.stepId ?? 'settings'),
                }))}
              />
            </div>
          }
        >
          {preview ? (
            <InspectorPanel
              icon={<Eye size={18} />}
              eyebrow={t('preview')}
              title={document.name || t('untitled')}
            >
              <p className="text-sm text-slate-500">{t('previewHelp')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>{t('sampleEmployee')}</Label>
                  <SearchSelect
                    value={sampleEmployment}
                    onChange={setSampleEmployment}
                    options={employments}
                    ariaLabel={t('sampleEmployee')}
                  />
                </div>
                <div>
                  <Label htmlFor="sample-date">{t('effectiveDate')}</Label>
                  <Input
                    id="sample-date"
                    type="date"
                    value={sampleDate}
                    onChange={(e) => setSampleDate(e.target.value)}
                  />
                </div>
              </div>
              <Button
                variant="outline"
                disabled={busy || !sampleEmployment || !sampleDate || issues.length > 0}
                onClick={() => void testCoverage()}
              >
                {t('testCoverage')}
              </Button>
              {coverage ? (
                <div className="space-y-2">
                  {coverage.steps.map((s) => (
                    <p key={s.id} className="text-sm">
                      <Check size={14} className="mr-2 inline text-teal-600" />
                      {s.title}
                      <span className="float-right text-slate-500">{s.dueOn}</span>
                    </p>
                  ))}
                </div>
              ) : null}
              {selected ? (
                <div className="space-y-4 border-t pt-4">
                  <h4 className="text-lg font-semibold">{selected.title}</h4>
                  <ChecklistStepContent
                    step={selected}
                    values={previewValues}
                    onChange={(key, value) => setPreviewValues((v) => ({ ...v, [key]: value }))}
                    acknowledged={previewValues.__ack === true}
                    onAcknowledge={(value) => setPreviewValues((v) => ({ ...v, __ack: value }))}
                  />
                  <p className="text-xs text-slate-500">{t('previewNoWrite')}</p>
                </div>
              ) : null}
            </InspectorPanel>
          ) : !selected ? (
            <InspectorPanel
              icon={<Settings2 size={18} />}
              eyebrow={t('settings')}
              title={t('settingsTitle')}
            >
              <div>
                <Label htmlFor="checklist-name">{t('name')}</Label>
                <Input
                  id="checklist-name"
                  value={document.name}
                  onChange={(e) => edit({ name: e.target.value })}
                  maxLength={200}
                />
              </div>
              <div>
                <Label>{t('kind')}</Label>
                <ChoiceCards
                  disabled={revision.current > 0}
                  value={document.kind}
                  options={(['onboarding', 'offboarding', 'transfer'] as const).map((value) => ({
                    value,
                    label: t(value),
                    description: t(value + 'Help'),
                    icon: <ClipboardList size={16} />,
                  }))}
                  ariaLabel={t('kind')}
                  onChange={(kind) => edit({ kind })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>{t('employer')}</Label>
                  <SearchSelect
                    value={document.appliesTo.employerSubsidiaryId ?? ''}
                    onChange={(value) =>
                      edit({
                        appliesTo: { ...document.appliesTo, employerSubsidiaryId: value || null },
                      })
                    }
                    options={subsidiaries}
                    ariaLabel={t('employer')}
                    emptyLabel={t('allEmployers')}
                    clearable
                  />
                </div>
                <div>
                  <Label>{t('department')}</Label>
                  <SearchSelect
                    value={document.appliesTo.departmentId ?? ''}
                    onChange={(value) =>
                      edit({ appliesTo: { ...document.appliesTo, departmentId: value || null } })
                    }
                    options={departments}
                    ariaLabel={t('department')}
                    emptyLabel={t('allDepartments')}
                    clearable
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500">{t('publishHelp')}</p>
              {active ? (
                <Button variant="outline" disabled={busy} onClick={() => void retire()}>
                  {t('retire')}
                </Button>
              ) : version ? (
                <p className="text-sm text-slate-500">{t('republishHelp')}</p>
              ) : null}
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {t('versionHistory')}
                </summary>
                {versions.map((v) => (
                  <div key={v.version} className="rounded-lg border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{t('version', { version: v.version })}</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void restore(v.version)}
                      >
                        {t('restore')}
                      </Button>
                    </div>
                    <p>{v.reason}</p>
                    <p className="text-xs text-slate-500">
                      {v.publishedBy} · {v.publishedAt}
                    </p>
                  </div>
                ))}
              </details>
            </InspectorPanel>
          ) : (
            <InspectorPanel
              icon={<ClipboardList size={18} />}
              eyebrow={t('stepNumber', { number: document.steps.indexOf(selected) + 1 })}
              title={selected.title || t('untitled')}
              actions={
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('duplicate')}
                    onClick={() => duplicate(selected)}
                  >
                    <Copy size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('delete')}
                    onClick={() => void remove(selected)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              }
            >
              <div>
                <Label htmlFor="step-title">{t('stepTitle')}</Label>
                <Input
                  id="step-title"
                  value={selected.title}
                  onChange={(e) => editStep({ title: e.target.value })}
                  maxLength={300}
                />
              </div>
              <div>
                <Label htmlFor="step-section">{t('section')}</Label>
                <Input
                  id="step-section"
                  value={selected.design.section}
                  onChange={(e) => editDesign({ section: e.target.value })}
                  maxLength={120}
                />
              </div>
              <div>
                <Label htmlFor="step-guide">{t('guidance')}</Label>
                <Textarea
                  id="step-guide"
                  rows={6}
                  value={selected.description ?? ''}
                  onChange={(e) => editStep({ description: e.target.value || null })}
                  placeholder={t('guidanceHelp')}
                  maxLength={12000}
                />
              </div>
              <div>
                <Label>{t('owner')}</Label>
                <ChoiceCards
                  columns={2}
                  value={selected.ownerKind}
                  ariaLabel={t('owner')}
                  options={(['manager', 'hr', 'employee', 'named_party'] as const).map((value) => ({
                    value,
                    label: t(value),
                    description: t(value + 'Help'),
                    icon: <UserRound size={16} />,
                  }))}
                  onChange={(ownerKind) => editStep({ ownerKind, ownerPartyId: null })}
                />
              </div>
              {selected.ownerKind === 'named_party' ? (
                <SearchSelect
                  value={selected.ownerPartyId ?? ''}
                  onChange={(ownerPartyId) => editStep({ ownerPartyId: ownerPartyId || null })}
                  options={employees}
                  ariaLabel={t('named_party')}
                />
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="step-days">{t('due')}</Label>
                  <Input
                    id="step-days"
                    type="number"
                    min={-3650}
                    max={3650}
                    value={selected.dueOffsetDays}
                    onChange={(e) => editStep({ dueOffsetDays: Number(e.target.value) })}
                  />
                  <p className="mt-1 text-xs text-slate-500">{t('dueHelp')}</p>
                </div>
                <div>
                  <Label htmlFor="step-reminder">{t('reminder')}</Label>
                  <Input
                    id="step-reminder"
                    type="number"
                    min={0}
                    max={365}
                    value={selected.design.reminderDays ?? ''}
                    onChange={(e) =>
                      editDesign({
                        reminderDays: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    placeholder={t('off')}
                  />
                  <p className="mt-1 text-xs text-slate-500">{t('reminderHelp')}</p>
                </div>
              </div>
              <div>
                <Label>{t('evidence')}</Label>
                <ChoiceCards
                  value={selected.evidenceKind}
                  ariaLabel={t('evidence')}
                  options={[
                    {
                      value: 'none',
                      label: t('none'),
                      description: t('noneHelp'),
                      icon: <Check size={16} />,
                    },
                    {
                      value: 'acknowledgement',
                      label: t('acknowledgement'),
                      description: t('acknowledgementHelp'),
                      icon: <ShieldCheck size={16} />,
                    },
                    {
                      value: 'attachment',
                      label: t('attachment'),
                      description: t('attachmentHelp'),
                      icon: <Paperclip size={16} />,
                    },
                  ]}
                  onChange={(evidenceKind) => editStep({ evidenceKind })}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.required}
                  onChange={(e) => editStep({ required: e.target.checked })}
                />
                {t('required')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.design.approval}
                  onChange={(e) => editDesign({ approval: e.target.checked })}
                />
                {t('approval')}
              </label>
              <p className="text-xs text-slate-500">{t('approvalHelp')}</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('responseForm')}</Label>
                  <AddFieldButton onAdd={addField} />
                </div>
                {selected.design.form?.sections.map((section) =>
                  section.fields.map((field, index) => (
                    <FieldRow
                      key={field.id}
                      field={field}
                      index={index}
                      count={section.fields.length}
                      sections={selected.design.form!.sections}
                      ownerSectionId={section.id}
                      expanded={expandedField === field.id}
                      onToggle={() =>
                        setExpandedField(expandedField === field.id ? null : field.id)
                      }
                      onChange={(patch) =>
                        editDesign({
                          form: {
                            ...selected.design.form!,
                            sections: selected.design.form!.sections.map((s) =>
                              s.id === section.id
                                ? {
                                    ...s,
                                    fields: s.fields.map((f) =>
                                      f.id === field.id ? { ...f, ...patch } : f,
                                    ),
                                  }
                                : s,
                            ),
                          },
                        })
                      }
                      onMove={(direction) => {
                        const fields = [...section.fields]
                        ;[fields[index], fields[index + direction]] = [
                          fields[index + direction]!,
                          fields[index]!,
                        ]
                        editDesign({
                          form: {
                            ...selected.design.form!,
                            sections: selected.design.form!.sections.map((s) =>
                              s.id === section.id ? { ...s, fields } : s,
                            ),
                          },
                        })
                      }}
                      onRemove={() => {
                        const remaining = selected.design.form!.sections.map((s) =>
                          s.id === section.id
                            ? { ...s, fields: s.fields.filter((f) => f.id !== field.id) }
                            : s,
                        )
                        editDesign({
                          form: remaining.every((s) => !s.fields.length)
                            ? null
                            : { ...selected.design.form!, sections: remaining },
                        })
                      }}
                    />
                  )),
                )}
              </div>
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">{t('resources')}</summary>
                {selected.design.resources.map((r, i) => (
                  <div key={i} className="flex flex-wrap gap-2 sm:flex-nowrap">
                    <Input
                      aria-label={t('linkLabel')}
                      value={r.label}
                      placeholder={t('linkLabel')}
                      onChange={(e) =>
                        editDesign({
                          resources: selected.design.resources.map((v, j) =>
                            j === i ? { ...v, label: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    <Input
                      aria-label={t('linkUrl')}
                      value={r.url}
                      placeholder="https://"
                      onChange={(e) =>
                        editDesign({
                          resources: selected.design.resources.map((v, j) =>
                            j === i ? { ...v, url: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('delete')}
                      onClick={() =>
                        editDesign({
                          resources: selected.design.resources.filter((_, j) => j !== i),
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    editDesign({
                      resources: [...selected.design.resources, { label: '', url: '' }],
                    })
                  }
                >
                  {t('addLink')}
                </Button>
              </details>
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {t('dependencies')}
                </summary>
                <p className="text-xs text-slate-500">{t('dependenciesHelp')}</p>
                {document.steps
                  .filter((s) => s.id !== selected.id)
                  .map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.design.dependencies.includes(s.id)}
                        onChange={(e) =>
                          editDesign({
                            dependencies: e.target.checked
                              ? [...selected.design.dependencies, s.id]
                              : selected.design.dependencies.filter((x) => x !== s.id),
                          })
                        }
                      />
                      {s.title || t('untitled')}
                    </label>
                  ))}
              </details>
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">{t('conditions')}</summary>
                <p className="text-xs text-slate-500">{t('conditionsHelp')}</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.design.condition !== null}
                    onChange={(e) =>
                      editDesign({ condition: e.target.checked ? { op: 'and', rules: [] } : null })
                    }
                  />
                  {t('conditional')}
                </label>
                {selected.design.condition ? (
                  <LogicRuleBuilder
                    rule={selected.design.condition}
                    onChange={(condition) => editDesign({ condition })}
                    profile={conditionProfile}
                    users={[]}
                  />
                ) : null}
              </details>
            </InspectorPanel>
          )}
        </BuilderSplit>
      </fieldset>
      <ContextMenu
        open={menu.open}
        position={menu.position}
        items={menuItems}
        onClose={menu.close}
      />
    </div>
  )
}
