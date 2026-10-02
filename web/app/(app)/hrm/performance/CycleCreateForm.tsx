'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Button, EmptyState, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useDirtyUrlDrawer } from '../../../../components/dirty-url-drawer'

/**
 * The cycle create form inside the cycle dialog. Fields are the house form
 * primitives, the request goes through POST /api/hrm/review-cycles, and
 * refusals render as the error, never swallowed. On success the URL moves
 * to the new cycle's own drawer.
 */
export interface CycleCreateProps {
  closeHref: string
  scopeOptions?: {
    subsidiaries: { value: string; label: string }[]
    departments: { value: string; label: string; subsidiaryId: string | null }[]
    unrestricted: boolean
  }
  templates: { value: string; label: string }[]
  initialTemplateId?: string
  emptyTemplates: string
  templateLabel: string
  nameLabel: string
  startLabel: string
  endLabel: string
  submitLabel: string
  cancelLabel: string
  setupHint: string
  setupHref: string | null
  failed: string
}

export function CycleCreateForm(props: CycleCreateProps) {
  const router = useRouter()
  const t = useTranslations('hrm.talentWorkspace')
  const [selfDue, setSelfDue] = useState(''),
    [managerDue, setManagerDue] = useState('')
  const [subsidiary, setSubsidiary] = useState(
    props.scopeOptions?.unrestricted
      ? ''
      : (props.scopeOptions?.subsidiaries[0]?.value ?? ''),
  )
  const [department, setDepartment] = useState('')
  const [requireManagerReviews, setRequireManagerReviews] = useState(true)
  const [templateId, setTemplateId] = useState(props.initialTemplateId ?? '')
  const [name, setName] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = useDirtyUrlDrawer(
    name !== '' ||
      templateId !== (props.initialTemplateId ?? '') ||
      periodStart !== '' ||
      periodEnd !== '' ||
      selfDue !== '' ||
      managerDue !== '' ||
      department !== '' ||
      !requireManagerReviews ||
      subsidiary !==
        (props.scopeOptions?.unrestricted
          ? ''
          : (props.scopeOptions?.subsidiaries[0]?.value ?? '')),
    busy,
  )

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/review-cycles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          templateId,
          name: name.trim(),
          periodStartOn: periodStart,
          periodEndOn: periodEnd,
          selfDueOn: selfDue || null,
          managerDueOn: managerDue || null,
          requireManagerReviews,
          appliesTo: {
            employer_subsidiary_id: subsidiary || null,
            department_id: department || null,
          },
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, props.failed))
        setBusy(false)
        return
      }
      const payload = (await res.json().catch(() => ({}))) as {
        cycle?: { id?: unknown }
      }
      const id = typeof payload.cycle?.id === 'string' ? payload.cycle.id : null
      if (id === null) {
        setError(props.failed)
        setBusy(false)
        return
      }
      router.push(`/hrm/performance?tab=cycles&cycle=${id}`)
      router.refresh()
    } catch {
      setError(props.failed)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="cycle-template">{props.templateLabel}</Label>
        {props.templates.length ? (
          <Select
            id="cycle-template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            required
          >
            <option value="">{props.templateLabel}</option>
            {props.templates.map((tpl) => (
              <option key={tpl.value} value={tpl.value}>
                {tpl.label}
              </option>
            ))}
          </Select>
        ) : (
          <EmptyState
            title={props.templateLabel}
            description={props.emptyTemplates}
          />
        )}
        {props.setupHref ? (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            <Link
              className="underline"
              href={props.setupHref}
              onClick={(event) => {
                event.preventDefault()
                void close(props.setupHref ?? undefined)
              }}
            >
              {props.setupHint}
            </Link>
          </p>
        ) : null}
      </div>
      <div>
        <Label htmlFor="cycle-name">{props.nameLabel}</Label>
        <Input
          id="cycle-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="cycle-start">{props.startLabel}</Label>
        <Input
          id="cycle-start"
          type="date"
          value={periodStart}
          onChange={(e) => setPeriodStart(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="cycle-end">{props.endLabel}</Label>
        <Input
          id="cycle-end"
          type="date"
          value={periodEnd}
          onChange={(e) => setPeriodEnd(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="self-due">{t('selfDue')}</Label>
          <Input
            id="self-due"
            type="date"
            value={selfDue}
            onChange={(e) => setSelfDue(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="manager-due">{t('managerDue')}</Label>
          <Input
            id="manager-due"
            type="date"
            value={managerDue}
            onChange={(e) => setManagerDue(e.target.value)}
          />
        </div>
      </div>
      {props.scopeOptions && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="cycle-subsidiary">{t('legalEntity')}</Label>
            <Select
              id="cycle-subsidiary"
              value={subsidiary}
              onChange={(e) => {
                setSubsidiary(e.target.value)
                setDepartment('')
              }}
            >
              {props.scopeOptions.unrestricted && (
                <option value="">{t('allEntities')}</option>
              )}
              {props.scopeOptions.subsidiaries.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="cycle-department">{t('department')}</Label>
            <Select
              id="cycle-department"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            >
              <option value="">{t('allDepartments')}</option>
              {props.scopeOptions.departments
                .filter((d) => !subsidiary || d.subsidiaryId === subsidiary)
                .map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
            </Select>
          </div>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={requireManagerReviews}
          onChange={(e) => setRequireManagerReviews(e.target.checked)}
        />
        {t('requireManager')}
      </label>
      <p className="text-xs text-slate-500">{t('createThenLaunch')}</p>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={
            busy || !templateId || !name.trim() || !periodStart || !periodEnd
          }
        >
          {t('saveDraft')}
        </Button>
        <Button type="button" variant="outline" onClick={() => void close()}>
          {props.cancelLabel}
        </Button>
      </div>
    </form>
  )
}
