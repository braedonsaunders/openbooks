'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Button,
  Input,
  Label,
  Select,
  Textarea,
  ContextMenu,
  useContextMenu,
  type ContextMenuEntry,
} from '@openbooks/ui'
import {
  Plus,
  Settings2,
  MessageSquare,
  Star,
  ArrowUp,
  ArrowDown,
  FileText,
} from 'lucide-react'
import type {
  ReviewTemplateDocument,
  ReviewTemplateDocumentDTO,
} from '@openbooks/engine/hrm/performance'
import {
  BuilderSplit,
  OutlinePanel,
  OutlineRow,
  InspectorPanel,
  ChoiceCards,
  useOutlineDrag,
} from '../../../../components/builder/builder-kit'
import {
  DirtyUrlDrawer,
  useDirtyUrlDrawer,
} from '../../../../components/dirty-url-drawer'
import { RecordTabs } from '../../../../components/module-home/record-tabs'
import { readApiErrorMessage } from '../../../../lib/api-error'

const clone = <T,>(value: T): T => structuredClone(value)
type Section = ReviewTemplateDocument['sections'][number]
type Question = Section['questions'][number]
export function ReviewTemplateDesigner({
  initial,
  closeHref,
  canEdit,
  competencies,
}: {
  initial: ReviewTemplateDocumentDTO | null
  closeHref: string
  canEdit: boolean
  competencies: { value: string; label: string }[]
}) {
  const t = useTranslations('hrm.talentWorkspace')
  const [savedTitle, setSavedTitle] = useState<string | null>(null)
  return (
    <DirtyUrlDrawer
      open
      closeHref={closeHref}
      title={savedTitle ?? initial?.draft.name ?? t('newTemplate')}
      size="2xl"
    >
      <TemplateEditor
        key={initial?.id ?? 'new'}
        initial={initial}
        canEdit={canEdit}
        competencies={competencies}
        onSaved={setSavedTitle}
      />
    </DirtyUrlDrawer>
  )
}
function TemplateEditor({
  initial,
  canEdit,
  competencies,
  onSaved,
}: {
  onSaved: (name: string) => void
  initial: ReviewTemplateDocumentDTO | null
  canEdit: boolean
  competencies: { value: string; label: string }[]
}) {
  const t = useTranslations('hrm.talentWorkspace'),
    common = useTranslations('common')
  const router = useRouter()
  const [saved, setSaved] = useState(initial)
  const [active, setActive] = useState(initial?.isActive ?? true)
  const [activeBaseline, setActiveBaseline] = useState(
    initial?.isActive ?? true,
  )
  const [document, setDocument] = useState<ReviewTemplateDocument | null>(
    initial ? clone(initial.draft) : null,
  )
  const [baseline, setBaseline] = useState(
    initial ? JSON.stringify(initial.draft) : '',
  )
  const [selected, setSelected] = useState('settings')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [status, setStatus] = useState('')
  const menu = useContextMenu(),
    [items, setItems] = useState<ContextMenuEntry[]>([])
  const drag = useOutlineDrag<{ key: string }>()
  const close = useDirtyUrlDrawer(
    !!document &&
      (JSON.stringify(document) !== baseline || active !== activeBaseline),
    busy,
  )
  const sections = document?.sections ?? []
  const section = sections.find((s) => s.id === selected)
  const question = sections
    .flatMap((s) => s.questions)
    .find((q) => q.id === selected)
  const owner = sections.find((s) => s.questions.some((q) => q.id === selected))
  function edit(patch: Partial<ReviewTemplateDocument>) {
    if (document) {
      setDocument({ ...document, ...patch })
      setStatus(t('unsaved'))
    }
  }
  function editQuestion(patch: Partial<Question>) {
    edit({
      sections: sections.map((s) => ({
        ...s,
        questions: s.questions.map((q) =>
          q.id === selected ? { ...q, ...patch } : q,
        ),
      })),
    })
  }
  function reorder(id: string, target: string, after: boolean) {
    const q = sections.flatMap((s) => s.questions).find((q) => q.id === id),
      targetSection = sections.find((s) =>
        s.questions.some((q) => q.id === target),
      )
    if (!q || !targetSection || id === target) return
    const next = clone(sections).map((s) => ({
      ...s,
      questions: s.questions.filter((q) => q.id !== id),
    }))
    const destination = next.find((s) => s.id === targetSection.id)!
    destination.questions.splice(
      destination.questions.findIndex((q) => q.id === target) + (after ? 1 : 0),
      0,
      q,
    )
    edit({ sections: next })
  }
  function addQuestion() {
    const target = section ?? owner ?? sections.at(-1)
    if (!target) return
    const q: Question = {
      id: crypto.randomUUID(),
      prompt: '',
      answerKind: 'text',
      required: true,
    }
    edit({
      sections: sections.map((s) =>
        s.id === target.id ? { ...s, questions: [...s.questions, q] } : s,
      ),
    })
    setSelected(q.id)
    setMode('edit')
  }
  async function save(publish: boolean) {
    if (!document || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/hrm/review-templates/designer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: saved?.id,
          revision: saved?.revision,
          document,
          publish,
          isActive: active,
        }),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('saveFailed')))
        return
      }
      const payload = (await response.json()) as {
        template?: ReviewTemplateDocumentDTO
      }
      if (!payload.template?.id || !payload.template.revision) {
        setError(t('saveFailed'))
        return
      }
      setActiveBaseline(payload.template.isActive)
      setSaved(payload.template)
      onSaved(payload.template.draft.name)
      setDocument(clone(payload.template.draft))
      setBaseline(JSON.stringify(payload.template.draft))
      setStatus(
        publish
          ? t('publishedVersion', {
              version: payload.template.publishedVersion,
            })
          : t('draftSaved'),
      )
      router.refresh()
    } catch {
      setError(t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const move = (by: number) => {
    if (!question || !owner) return
    const i = owner.questions.findIndex((q) => q.id === selected),
      other = owner.questions[i + by]
    if (other) reorder(selected, other.id, by > 0)
  }
  return (
    <div className="space-y-5">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      {document ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <RecordTabs
              label={t('designer')}
              active={mode}
              onChange={setMode}
              tabs={[
                { key: 'edit', label: t('editQuestions') },
                { key: 'preview', label: t('preview') },
              ]}
            />
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void save(false)}
                >
                  {t('saveDraft')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  {t('publish')}
                </Button>
              </div>
            )}
          </div>
          {mode === 'preview' ? (
            <div className="mx-auto max-w-2xl space-y-5">
              <p className="text-sm text-slate-500">{document.instructions}</p>
              {sections.map((s) => (
                <section
                  key={s.id}
                  className="space-y-3 rounded-lg border border-slate-200 p-5"
                >
                  <h3 className="font-semibold">{s.title}</h3>
                  {s.questions.map((q) => (
                    <div key={q.id} className="space-y-2">
                      <Label htmlFor={'preview-' + q.id}>
                        {q.prompt || t('newQuestion')}
                        {q.required ? ' *' : ''}
                      </Label>
                      {q.answerKind !== 'text' && (
                        <Input
                          id={'preview-' + q.id}
                          disabled
                          placeholder={
                            document.ratingScale.min +
                            '–' +
                            document.ratingScale.max
                          }
                        />
                      )}
                      {q.answerKind !== 'rating' && (
                        <Textarea
                          id={
                            q.answerKind === 'text'
                              ? 'preview-' + q.id
                              : 'preview-text-' + q.id
                          }
                          disabled
                        />
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <BuilderSplit
              outline={
                <OutlinePanel
                  title={t('structure')}
                  actions={
                    canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('addSection')}
                        disabled={busy}
                        onClick={() => {
                          const s: Section = {
                            id: crypto.randomUUID(),
                            title: t('newSection'),
                            kind: 'free_text',
                            questions: [],
                          }
                          edit({ sections: [...sections, s] })
                          setSelected(s.id)
                        }}
                      >
                        <Plus size={15} />
                      </Button>
                    )
                  }
                  footer={
                    canEdit && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !sections.length}
                        className="w-full"
                        onClick={addQuestion}
                      >
                        <Plus size={15} />
                        {t('addQuestion')}
                      </Button>
                    )
                  }
                >
                  <OutlineRow
                    selected={selected === 'settings'}
                    icon={<Settings2 size={15} />}
                    label={t('templateSettings')}
                    onSelect={() => setSelected('settings')}
                  />
                  {sections.map((s) => (
                    <div key={s.id}>
                      <OutlineRow
                        selected={selected === s.id}
                        icon={<FileText size={15} />}
                        label={s.title}
                        meta={t('questionCount', { count: s.questions.length })}
                        onSelect={() => setSelected(s.id)}
                      />
                      {s.questions.map((q) => (
                        <OutlineRow
                          key={q.id}
                          selected={selected === q.id}
                          depth={1}
                          icon={
                            q.answerKind === 'text' ? (
                              <MessageSquare size={14} />
                            ) : (
                              <Star size={14} />
                            )
                          }
                          label={q.prompt}
                          placeholder={t('newQuestion')}
                          meta={q.required ? t('required') : undefined}
                          onSelect={() => setSelected(q.id)}
                          drag={
                            canEdit && !busy
                              ? drag.bind(
                                  q.id,
                                  { key: q.id },
                                  {
                                    canDrop: () => true,
                                    onDrop: (item, place) =>
                                      reorder(
                                        item.key,
                                        q.id,
                                        place === 'after',
                                      ),
                                  },
                                )
                              : undefined
                          }
                          dropPlace={drag.dropPlace(q.id)}
                          grabLabel={t('reorderQuestion')}
                          menuLabel={t('questionActions')}
                          onMenu={
                            canEdit && !busy
                              ? (anchor) => {
                                  setItems([
                                    {
                                      key: 'duplicate',
                                      label: t('duplicateQuestion'),
                                      onSelect: () => {
                                        const duplicate = {
                                          ...q,
                                          id: crypto.randomUUID(),
                                        }
                                        edit({
                                          sections: sections.map((current) =>
                                            current.id === s.id
                                              ? {
                                                  ...current,
                                                  questions: [
                                                    ...current.questions,
                                                    duplicate,
                                                  ],
                                                }
                                              : current,
                                          ),
                                        })
                                        setSelected(duplicate.id)
                                      },
                                    },
                                    {
                                      key: 'remove',
                                      label: t('removeQuestion'),
                                      onSelect: () => {
                                        edit({
                                          sections: sections.map((current) => ({
                                            ...current,
                                            questions: current.questions.filter(
                                              (item) => item.id !== q.id,
                                            ),
                                          })),
                                        })
                                        setSelected(s.id)
                                      },
                                    },
                                  ])
                                  menu.openBelow(anchor)
                                }
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  ))}
                </OutlinePanel>
              }
            >
              <InspectorPanel
                icon={
                  question ? (
                    <MessageSquare size={19} />
                  ) : (
                    <Settings2 size={19} />
                  )
                }
                eyebrow={
                  question
                    ? t('question')
                    : section
                      ? t('section')
                      : t('template')
                }
                title={
                  question?.prompt || section?.title || t('templateSettings')
                }
                actions={
                  question &&
                  canEdit && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={t('moveUp')}
                        onClick={() => move(-1)}
                      >
                        <ArrowUp size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={t('moveDown')}
                        onClick={() => move(1)}
                      >
                        <ArrowDown size={14} />
                      </Button>
                    </div>
                  )
                }
              >
                <fieldset disabled={!canEdit || busy} className="space-y-5">
                  {question ? (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="question-prompt">{t('question')}</Label>
                        <Textarea
                          id="question-prompt"
                          value={question.prompt}
                          onChange={(e) =>
                            editQuestion({ prompt: e.target.value })
                          }
                        />
                      </div>
                      <ChoiceCards
                        ariaLabel={t('responseType')}
                        value={question.answerKind}
                        disabled={!canEdit || busy}
                        onChange={(answerKind) => editQuestion({ answerKind })}
                        options={[
                          {
                            value: 'rating_and_text',
                            label: t('ratingAndComments'),
                          },
                          { value: 'rating', label: t('rating') },
                          { value: 'text', label: t('text') },
                        ]}
                      />
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={question.required}
                          onChange={(e) =>
                            editQuestion({ required: e.target.checked })
                          }
                        />
                        {t('answerRequired')}
                      </label>
                    </>
                  ) : section ? (
                    <>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const i = sections.findIndex(
                              (s) => s.id === section.id,
                            )
                            if (i > 0) {
                              const next = [...sections]
                              ;[next[i - 1], next[i]] = [next[i]!, next[i - 1]!]
                              edit({ sections: next })
                            }
                          }}
                        >
                          {t('moveUp')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const i = sections.findIndex(
                              (s) => s.id === section.id,
                            )
                            if (i < sections.length - 1) {
                              const next = [...sections]
                              ;[next[i], next[i + 1]] = [next[i + 1]!, next[i]!]
                              edit({ sections: next })
                            }
                          }}
                        >
                          {t('moveDown')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            edit({
                              sections: sections.filter(
                                (s) => s.id !== section.id,
                              ),
                            })
                            setSelected('settings')
                          }}
                        >
                          {t('removeSection')}
                        </Button>
                      </div>
                      <Label htmlFor="section-title">{t('sectionTitle')}</Label>
                      <Input
                        id="section-title"
                        value={section.title}
                        onChange={(e) =>
                          edit({
                            sections: sections.map((s) =>
                              s.id === section.id
                                ? { ...s, title: e.target.value }
                                : s,
                            ),
                          })
                        }
                      />
                      <ChoiceCards
                        ariaLabel={t('sectionType')}
                        value={section.kind}
                        disabled={!canEdit || busy}
                        onChange={(kind) =>
                          edit({
                            sections: sections.map((s) =>
                              s.id === section.id ? { ...s, kind } : s,
                            ),
                          })
                        }
                        options={[
                          { value: 'free_text', label: t('text') },
                          { value: 'goals', label: t('goals') },
                          { value: 'competency', label: t('competency') },
                        ]}
                      />
                      <div>
                        <Label htmlFor="section-weight">{t('weight')}</Label>
                        <Input
                          id="section-weight"
                          inputMode="decimal"
                          value={section.weight ?? ''}
                          onChange={(e) =>
                            edit({
                              sections: sections.map((s) =>
                                s.id === section.id
                                  ? { ...s, weight: e.target.value || null }
                                  : s,
                              ),
                            })
                          }
                        />
                      </div>
                      {section.kind === 'competency' && (
                        <div>
                          <Label htmlFor="section-competency">
                            {t('competency')}
                          </Label>
                          <Select
                            id="section-competency"
                            value={section.competencyId ?? ''}
                            onChange={(e) =>
                              edit({
                                sections: sections.map((s) =>
                                  s.id === section.id
                                    ? {
                                        ...s,
                                        competencyId: e.target.value || null,
                                      }
                                    : s,
                                ),
                              })
                            }
                          >
                            <option value="">{common('labels.none')}</option>
                            {competencies.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div>
                        <Label htmlFor="template-name">
                          {t('templateName')}
                        </Label>
                        <Input
                          id="template-name"
                          value={document.name}
                          onChange={(e) => edit({ name: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor="template-instructions">
                          {t('instructions')}
                        </Label>
                        <Textarea
                          id="template-instructions"
                          value={document.instructions}
                          onChange={(e) =>
                            edit({ instructions: e.target.value })
                          }
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="scale-min">{t('scaleMin')}</Label>
                          <Input
                            id="scale-min"
                            value={document.ratingScale.min}
                            onChange={(e) =>
                              edit({
                                ratingScale: {
                                  ...document.ratingScale,
                                  min: e.target.value,
                                },
                              })
                            }
                          />
                        </div>
                        <div>
                          <Label htmlFor="scale-max">{t('scaleMax')}</Label>
                          <Input
                            id="scale-max"
                            value={document.ratingScale.max}
                            onChange={(e) =>
                              edit({
                                ratingScale: {
                                  ...document.ratingScale,
                                  max: e.target.value,
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                      <div>
                        <Label htmlFor="scale-labels">{t('scaleLabels')}</Label>
                        <Textarea
                          id="scale-labels"
                          value={document.ratingScale.labels.join('\n')}
                          onChange={(e) =>
                            edit({
                              ratingScale: {
                                ...document.ratingScale,
                                labels: e.target.value.split('\n'),
                              },
                            })
                          }
                        />
                      </div>
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={(e) => setActive(e.target.checked)}
                        />
                        {t('activeTemplate')}
                      </label>
                      <p className="text-xs text-slate-500">
                        {t('capturedVersions')}
                      </p>
                    </>
                  )}
                </fieldset>
              </InspectorPanel>
            </BuilderSplit>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              {t('questionCount', {
                count: sections.reduce((n, s) => n + s.questions.length, 0),
              })}
            </span>
            <span role="status">{status}</span>
          </div>
        </>
      ) : (
        <ChoiceCards
          ariaLabel={t('startingPoint')}
          value=""
          columns={2}
          options={[
            { value: 'quarterly', label: t('quarterlyReview') },
            { value: 'probation', label: t('probationReview') },
            { value: 'checkin', label: t('managerCheckin') },
            { value: 'blank', label: t('blankTemplate') },
          ]}
          onChange={(key) => {
            const prompts =
              key === 'blank'
                ? []
                : key === 'probation'
                  ? [t('probationQuestion'), t('supportQuestion')]
                  : key === 'checkin'
                    ? [t('progressQuestion'), t('supportQuestion')]
                    : [
                        t('resultsQuestion'),
                        t('strengthsQuestion'),
                        t('focusQuestion'),
                      ]
            setDocument({
              name: t(
                key === 'probation'
                  ? 'probationReview'
                  : key === 'checkin'
                    ? 'managerCheckin'
                    : key === 'blank'
                      ? 'newTemplate'
                      : 'quarterlyReview',
              ),
              instructions: '',
              ratingScale: { min: '1', max: '5', labels: [] },
              sections: [
                {
                  id: crypto.randomUUID(),
                  title: t('reviewQuestions'),
                  kind: 'free_text',
                  questions: prompts.map((prompt, i) => ({
                    id: crypto.randomUUID(),
                    prompt,
                    answerKind:
                      i === 0 && key === 'quarterly'
                        ? 'rating_and_text'
                        : 'text',
                    required: i < 2,
                  })),
                },
              ],
            })
          }}
        />
      )}
      <ContextMenu
        open={menu.open}
        position={menu.position}
        onClose={menu.close}
        items={items}
      />
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => void close()}
      >
        {common('actions.close')}
      </Button>
    </div>
  )
}
