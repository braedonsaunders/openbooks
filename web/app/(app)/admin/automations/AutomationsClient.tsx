'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Client islands for the automations list: the New-automation dialog (name
 * + trigger kind, creating a draft recipe and landing on its builder) and
 * per-row enable/disable/run-now controls. Every refusal renders with its
 * message intact — res.ok is checked before any body is parsed.
 */

const TRIGGER_KINDS = ['schedule', 'date_relative', 'field_change', 'event', 'document', 'manual'] as const

function defaultTrigger(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'schedule':
      return { kind, cron: '0 9 * * MON', timezone: 'UTC' }
    case 'date_relative':
      return { kind, entity: 'employment', dateField: 'service_start', offsetDays: 3, direction: 'before', atTime: '09:00' }
    case 'field_change':
      return { kind, entity: 'employment', field: 'status' }
    case 'event':
      return { kind, subjectKind: 'hrm_employment_change_request', eventKind: 'approved' }
    case 'document':
      return { kind, event: 'signed' }
    default:
      return { kind: 'manual' }
  }
}

export function NewAutomationButton({ label }: { label: string }) {
  const t = useTranslations('admin.automations')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<string>('schedule')
  const [recipeKey, setRecipeKey] = useState<string>('')
  const [recipes, setRecipes] = useState<{ key: string; name: string; description: string; trigger: Record<string, unknown>; actions: Record<string, unknown>[] }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/automations/recipes', { method: 'GET' })
      .then(async (res) => {
        if (!res.ok) return
        const payload = (await res.json().catch(() => ({}))) as { recipes?: typeof recipes }
        if (Array.isArray(payload.recipes)) setRecipes(payload.recipes)
      })
      .catch(() => {})
  }, [open])

  async function create() {
    const recipe = recipes.find((r) => r.key === recipeKey)
    const recipeName = recipe?.name ?? ''
    if (!name.trim() && !recipe) {
      setError(t('list.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          recipe
            ? { name: name.trim() || recipeName, description: recipe.description, trigger: recipe.trigger, rules: {}, conditions: {}, actions: recipe.actions }
            : {
                name: name.trim(),
                trigger: defaultTrigger(kind),
                rules: {},
                conditions: {},
                actions: [{ kind: 'send_notification', to: 'manager', body: '' }],
              },
        ),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('list.createFailed')))
        return
      }
      const payload = (await res.json().catch(() => ({}))) as { automation?: { id?: string } }
      const id = payload.automation?.id
      setOpen(false)
      if (typeof id === 'string') router.push(`/admin/automations/${id}` as never)
      else router.refresh()
    } catch {
      setError(t('list.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{label}</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t('list.newTitle')} footer={<><Button variant="outline" onClick={() => setOpen(false)}>{t('list.cancel')}</Button><Button disabled={busy} onClick={create}>{t('list.create')}</Button></>}>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="automation-recipe">{t('list.recipeLabel')}</Label>
            <Select id="automation-recipe" value={recipeKey} onChange={(e) => {
              const key = e.target.value
              setRecipeKey(key)
              const picked = recipes.find((r) => r.key === key)
              if (picked && !name.trim()) setName(picked.name)
              setError(null)
            }}>
              <option value="">{t('list.recipeBlank')}</option>
              {recipes.map((r) => (
                <option key={r.key} value={r.key}>{r.name}</option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="automation-name">{t('list.nameLabel')}</Label>
            <Input id="automation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('list.namePlaceholder')} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="automation-trigger">{t('list.triggerLabel')}</Label>
            <Select id="automation-trigger" value={kind} disabled={recipeKey !== ''} onChange={(e) => setKind(e.target.value)}>
              {TRIGGER_KINDS.map((k) => (
                <option key={k} value={k}>{t(`triggerKinds.${k}`)}</option>
              ))}
            </Select>
          </div>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
      </Drawer>
    </>
  )
}

export function AutomationRowActions({
  id,
  status,
  runLabel,
  enableLabel,
  disableLabel,
  actionFailed,
}: {
  id: string
  status: string
  runLabel: string
  enableLabel: string
  disableLabel: string
  actionFailed: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function call(url: string, body?: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      if (!res.ok) toast.error(await readApiErrorMessage(res, actionFailed))
      router.refresh()
    } catch {
      toast.error(actionFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {status === 'enabled' ? (
        <Button variant="outline" disabled={busy} onClick={() => call(`/api/automations/${id}/status`, { status: 'disabled' })}>
          {disableLabel}
        </Button>
      ) : (
        <Button variant="outline" disabled={busy} onClick={() => call(`/api/automations/${id}/status`, { status: 'enabled' })}>
          {enableLabel}
        </Button>
      )}
      <Button variant="outline" disabled={busy || status !== 'enabled'} onClick={() => call(`/api/automations/${id}/run`, {})}>
        {runLabel}
      </Button>
    </span>
  )
}

/**
 * Exception-only approval tuning per subject kind (HR-16): a setting over
 * the existing Flows gates, never a second gate. One card per subject with
 * the exception flag, the threshold JSON the scorer checks by name,
 * auto-approve-when-no-rule, delegation timing, and initiator exclusion.
 * Saves POST the approval-settings route; refusals toast with the remedy.
 */
export function AutomationApprovalSettings({
  settings,
  saveFailed,
  savedLabel,
  saveLabel,
  titleLabel,
  helpLabel,
  exceptionLabel,
  thresholdsLabel,
  autoApproveLabel,
  delegateLabel,
  excludeLabel,
  yesLabel,
  noLabel,
}: {
  settings: { subjectKind: string; exceptionOnly: boolean; thresholds: Record<string, unknown>; autoApproveWhenNoRule: boolean; delegateAfterDays: number | null; excludeInitiator: boolean }[]
  saveFailed: string
  savedLabel: string
  saveLabel: string
  titleLabel: string
  helpLabel: string
  exceptionLabel: string
  thresholdsLabel: string
  autoApproveLabel: string
  delegateLabel: string
  excludeLabel: string
  yesLabel: string
  noLabel: string
}) {
  const router = useRouter()
  const [drafts, setDrafts] = useState<Record<string, { exceptionOnly: boolean; thresholds: string; autoApproveWhenNoRule: boolean; delegateAfterDays: string; excludeInitiator: boolean }>>(() =>
    Object.fromEntries(
      settings.map((s) => [
        s.subjectKind,
        {
          exceptionOnly: s.exceptionOnly,
          thresholds: JSON.stringify(s.thresholds ?? {}, null, 2),
          autoApproveWhenNoRule: s.autoApproveWhenNoRule,
          delegateAfterDays: s.delegateAfterDays === null ? '' : String(s.delegateAfterDays),
          excludeInitiator: s.excludeInitiator,
        },
      ]),
    ),
  )
  const [busy, setBusy] = useState(false)

  function set(subjectKind: string, patch: Partial<{ exceptionOnly: boolean; thresholds: string; autoApproveWhenNoRule: boolean; delegateAfterDays: string; excludeInitiator: boolean }>) {
    setDrafts((prev) => ({ ...prev, [subjectKind]: { ...prev[subjectKind]!, ...patch } }))
  }

  async function save(subjectKind: string) {
    const draft = drafts[subjectKind]
    if (!draft) return
    let thresholds: Record<string, unknown> = {}
    try {
      const parsed: unknown = draft.thresholds.trim() ? JSON.parse(draft.thresholds) : {}
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object')
      thresholds = parsed as Record<string, unknown>
    } catch {
      toast.error(saveFailed)
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/automations/approval-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectKind,
          exceptionOnly: draft.exceptionOnly,
          thresholds,
          autoApproveWhenNoRule: draft.autoApproveWhenNoRule,
          delegateAfterDays: draft.delegateAfterDays === '' ? null : Number(draft.delegateAfterDays),
          excludeInitiator: draft.excludeInitiator,
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, saveFailed))
        return
      }
      toast.success(savedLabel)
      router.refresh()
    } catch {
      toast.error(saveFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
      <h2 className="text-sm font-semibold">{titleLabel}</h2>
      <p className="mt-1 text-xs text-slate-500">{helpLabel}</p>
      <div className="mt-3 grid gap-3">
        {settings.map((s) => {
          const draft = drafts[s.subjectKind]
          if (!draft) return null
          return (
            <div key={s.subjectKind} className="grid gap-2 rounded-md border p-3">
              <h3 className="font-mono text-xs font-semibold">{s.subjectKind}</h3>
              <div className="grid gap-1">
                <Label htmlFor={`aas-exc-${s.subjectKind}`}>{exceptionLabel}</Label>
                <Select id={`aas-exc-${s.subjectKind}`} value={draft.exceptionOnly ? 'yes' : 'no'} onChange={(e) => set(s.subjectKind, { exceptionOnly: e.target.value === 'yes' })}>
                  <option value="yes">{yesLabel}</option>
                  <option value="no">{noLabel}</option>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`aas-th-${s.subjectKind}`}>{thresholdsLabel}</Label>
                <Textarea id={`aas-th-${s.subjectKind}`} rows={3} value={draft.thresholds} onChange={(e) => set(s.subjectKind, { thresholds: e.target.value })} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`aas-auto-${s.subjectKind}`}>{autoApproveLabel}</Label>
                <Select id={`aas-auto-${s.subjectKind}`} value={draft.autoApproveWhenNoRule ? 'yes' : 'no'} onChange={(e) => set(s.subjectKind, { autoApproveWhenNoRule: e.target.value === 'yes' })}>
                  <option value="yes">{yesLabel}</option>
                  <option value="no">{noLabel}</option>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`aas-del-${s.subjectKind}`}>{delegateLabel}</Label>
                <Input id={`aas-del-${s.subjectKind}`} value={draft.delegateAfterDays} onChange={(e) => set(s.subjectKind, { delegateAfterDays: e.target.value })} placeholder="7" />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`aas-exi-${s.subjectKind}`}>{excludeLabel}</Label>
                <Select id={`aas-exi-${s.subjectKind}`} value={draft.excludeInitiator ? 'yes' : 'no'} onChange={(e) => set(s.subjectKind, { excludeInitiator: e.target.value === 'yes' })}>
                  <option value="yes">{yesLabel}</option>
                  <option value="no">{noLabel}</option>
                </Select>
              </div>
              <div><Button disabled={busy} onClick={() => save(s.subjectKind)}>{saveLabel}</Button></div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
