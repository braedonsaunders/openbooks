'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Input, Label, SearchSelect, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../../lib/api-error'
import { confirmDialog } from '../../../../../lib/confirm'

type Option = { value: string; label: string }
type Kind = 'onboarding' | 'offboarding' | 'transfer'
type Step = {
  id: string
  position: number
  title: string
  description: string | null
  ownerKind: string
  ownerPartyId: string | null
  dueOffsetDays: number
  required: boolean
  evidenceKind: string
}
export type ProcessTemplateEditorValue = {
  id: string
  kind: Kind
  name: string
  appliesTo: { employerSubsidiaryId: string | null; departmentId: string | null }
  isActive: boolean
  steps: Step[]
}

type StepDraft = Omit<Step, 'id'> & { id?: string }

function blankStep(position: number): StepDraft {
  return {
    position,
    title: '',
    description: null,
    ownerKind: 'manager',
    ownerPartyId: null,
    dueOffsetDays: 0,
    required: true,
    evidenceKind: 'none',
  }
}

/** One drawer component owns template creation and editing. Checklist
 * instances intentionally do not share this form: opening snapshots the
 * template, and history changes only through checklist lifecycle actions. */
export function ProcessTemplateDrawer({
  template,
  creating,
  closeHref,
  subsidiaries,
  departments,
  employees,
}: {
  template: ProcessTemplateEditorValue | null
  creating: boolean
  closeHref: string
  subsidiaries: Option[]
  departments: Option[]
  employees: Option[]
}) {
  const t = useTranslations('hrm.processes.templates')
  const tc = useTranslations('common')
  const router = useRouter()
  const [name, setName] = useState(template?.name ?? '')
  const [kind, setKind] = useState<Kind>(template?.kind ?? 'onboarding')
  const [subsidiaryId, setSubsidiaryId] = useState(template?.appliesTo.employerSubsidiaryId ?? '')
  const [departmentId, setDepartmentId] = useState(template?.appliesTo.departmentId ?? '')
  const [active, setActive] = useState(template?.isActive ?? true)
  const [busy, setBusy] = useState(false)
  const [stepDraft, setStepDraft] = useState<StepDraft | null>(null)

  async function saveTemplate() {
    if (!name.trim()) return
    setBusy(true)
    const response = await fetch(
      creating ? '/api/hrm/process-templates' : `/api/hrm/process-templates/${template!.id}`,
      {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(creating ? { kind } : {}),
          name: name.trim(),
          ...(creating ? {} : { isActive: active }),
          appliesTo: {
            employerSubsidiaryId: subsidiaryId || null,
            departmentId: departmentId || null,
          },
        }),
      },
    )
    setBusy(false)
    if (!response.ok) {
      toast.error(await readApiErrorMessage(response, t('saveFailed')))
      return
    }
    const payload = (await response.json()) as { template?: { id?: string } }
    toast.success(creating ? t('created') : t('updated'))
    if (creating && payload.template?.id) {
      router.replace(`/hrm/processes/templates?template=${payload.template.id}` as never)
    }
    router.refresh()
  }

  async function saveStep() {
    if (!template || !stepDraft?.title.trim()) return
    // The offset posts as days, not a date: a non-integer or out-of-range
    // value refuses by name instead of posting NaN.
    if (
      !Number.isInteger(stepDraft.dueOffsetDays) ||
      stepDraft.dueOffsetDays < -3650 ||
      stepDraft.dueOffsetDays > 3650
    ) {
      toast.error(t('stepOffsetInvalid'))
      return
    }
    setBusy(true)
    const editing = Boolean(stepDraft.id)
    const response = await fetch(
      editing
        ? `/api/hrm/process-templates/${template.id}/steps/${stepDraft.id}`
        : `/api/hrm/process-templates/${template.id}/steps`,
      {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...stepDraft,
          title: stepDraft.title.trim(),
          description: stepDraft.description?.trim() || null,
          ownerPartyId: stepDraft.ownerKind === 'named_party' ? stepDraft.ownerPartyId : null,
        }),
      },
    )
    setBusy(false)
    if (!response.ok) {
      toast.error(await readApiErrorMessage(response, t('stepSaveFailed')))
      return
    }
    toast.success(editing ? t('stepUpdated') : t('stepCreated'))
    setStepDraft(null)
    router.refresh()
  }

  async function removeStep(step: Step) {
    if (!template) return
    if (
      !(await confirmDialog({
        message: t('confirmDeleteStep', { title: step.title }),
        confirmLabel: tc('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const response = await fetch(`/api/hrm/process-templates/${template.id}/steps/${step.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!response.ok) {
      toast.error(await readApiErrorMessage(response, t('stepDeleteFailed')))
      return
    }
    if (stepDraft?.id === step.id) setStepDraft(null)
    toast.success(t('stepDeleted'))
    router.refresh()
  }

  const nextPosition = template ? Math.max(-1, ...template.steps.map((step) => step.position)) + 1 : 0

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={creating ? t('newTemplate') : t('editTemplate')}
      description={creating ? t('createDescription') : t('editDescription')}
      headerActions={
        <Button disabled={busy || !name.trim()} onClick={saveTemplate}>
          {busy ? tc('actions.saving') : creating ? tc('actions.create') : tc('actions.save')}
        </Button>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="template-name">{t('name')}</Label>
            <Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="template-kind">{t('kind')}</Label>
            <Select
              id="template-kind"
              value={kind}
              disabled={!creating}
              onChange={(event) => setKind(event.target.value as Kind)}
            >
              <option value="onboarding">{t('kinds.onboarding')}</option>
              <option value="offboarding">{t('kinds.offboarding')}</option>
              <option value="transfer">{t('kinds.transfer')}</option>
            </Select>
          </div>
          {!creating ? (
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              {t('active')}
            </label>
          ) : null}
          <div>
            <Label htmlFor="template-subsidiary">{t('subsidiary')}</Label>
            <SearchSelect
              id="template-subsidiary"
              value={subsidiaryId}
              onChange={setSubsidiaryId}
              options={subsidiaries}
              ariaLabel={t('subsidiary')}
              sheetTitle={t('subsidiary')}
              emptyLabel={t('allSubsidiaries')}
            />
          </div>
          <div>
            <Label htmlFor="template-department">{t('department')}</Label>
            <SearchSelect
              id="template-department"
              value={departmentId}
              onChange={setDepartmentId}
              options={departments}
              ariaLabel={t('department')}
              sheetTitle={t('department')}
              emptyLabel={t('allDepartments')}
            />
          </div>
        </div>

        {creating ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
            {t('saveBeforeSteps')}
          </p>
        ) : template ? (
          <section className="space-y-3 border-t border-slate-200 pt-5 dark:border-slate-800">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('steps')}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">{t('stepsDescription')}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStepDraft(blankStep(nextPosition))}>
                <Plus size={14} /> {t('addStep')}
              </Button>
            </div>
            {template.steps.length === 0 ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                {t('noSteps')}
              </p>
            ) : (
              <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {template.steps.map((step) => (
                  <div key={step.id} className="flex items-center justify-between gap-3 p-3">
                    <button type="button" className="min-w-0 text-left" onClick={() => setStepDraft({ ...step })}>
                      <span className="block font-medium text-slate-900 dark:text-slate-100">{step.position + 1}. {step.title}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {t('stepSummary', { owner: t(`owners.${step.ownerKind}`), days: step.dueOffsetDays })}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={t('deleteStep')}
                      className="text-slate-400 hover:text-red-600"
                      onClick={() => void removeStep(step)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {stepDraft ? (
              <div className="grid gap-4 rounded-lg border border-slate-200 p-4 sm:grid-cols-2 dark:border-slate-800">
                <h4 className="text-sm font-semibold text-slate-900 sm:col-span-2 dark:text-slate-100">
                  {stepDraft.id ? t('editStep') : t('newStep')}
                </h4>
                <div className="sm:col-span-2">
                  <Label htmlFor="step-title">{t('stepTitle')}</Label>
                  <Input id="step-title" value={stepDraft.title} onChange={(event) => setStepDraft({ ...stepDraft, title: event.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="step-description">{t('stepDescription')}</Label>
                  <Textarea id="step-description" value={stepDraft.description ?? ''} onChange={(event) => setStepDraft({ ...stepDraft, description: event.target.value })} />
                </div>
                <div>
                  <Label htmlFor="step-owner">{t('owner')}</Label>
                  <Select id="step-owner" value={stepDraft.ownerKind} onChange={(event) => setStepDraft({ ...stepDraft, ownerKind: event.target.value, ownerPartyId: null })}>
                    <option value="manager">{t('owners.manager')}</option>
                    <option value="hr">{t('owners.hr')}</option>
                    <option value="employee">{t('owners.employee')}</option>
                    <option value="named_party">{t('owners.named_party')}</option>
                  </Select>
                </div>
                {stepDraft.ownerKind === 'named_party' ? (
                  <div>
                    <Label htmlFor="step-owner-party">{t('namedOwner')}</Label>
                    <SearchSelect
                      id="step-owner-party"
                      value={stepDraft.ownerPartyId ?? ''}
                      onChange={(value) => setStepDraft({ ...stepDraft, ownerPartyId: value || null })}
                      options={employees}
                      ariaLabel={t('namedOwner')}
                      sheetTitle={t('namedOwner')}
                      emptyLabel="—"
                    />
                  </div>
                ) : null}
                <div>
                  <Label htmlFor="step-offset">{t('dueOffset')}</Label>
                  <Input
                    id="step-offset"
                    type="number"
                    value={stepDraft.dueOffsetDays}
                    onChange={(event) => {
                      const parsed = Number(event.target.value)
                      // A non-numeric keystroke never becomes NaN in the
                      // draft: the last good value stays, and saveStep
                      // refuses anything outside the whole-day range by name.
                      if (!Number.isFinite(parsed)) return
                      setStepDraft({ ...stepDraft, dueOffsetDays: parsed })
                    }}
                  />
                </div>
                <div>
                  <Label htmlFor="step-evidence">{t('evidence')}</Label>
                  <Select id="step-evidence" value={stepDraft.evidenceKind} onChange={(event) => setStepDraft({ ...stepDraft, evidenceKind: event.target.value })}>
                    <option value="none">{t('evidenceKinds.none')}</option>
                    <option value="acknowledgement">{t('evidenceKinds.acknowledgement')}</option>
                    <option value="attachment">{t('evidenceKinds.attachment')}</option>
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={stepDraft.required}
                    onChange={(event) => setStepDraft({ ...stepDraft, required: event.target.checked })}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  {t('required')}
                </label>
                <div className="flex justify-end gap-2 sm:col-span-2">
                  <Button variant="outline" onClick={() => setStepDraft(null)}>{tc('actions.cancel')}</Button>
                  <Button disabled={busy || !stepDraft.title.trim() || (stepDraft.ownerKind === 'named_party' && !stepDraft.ownerPartyId)} onClick={saveStep}>
                    {busy ? tc('actions.saving') : tc('actions.save')}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </UrlDrawer>
  )
}
