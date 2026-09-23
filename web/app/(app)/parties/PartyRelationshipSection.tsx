'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select, Skeleton } from '@openbooks/ui'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { displayAccountStatusName } from '../../../lib/crm-status-display'

/**
 * The Relationship tab of the account flyout — the CRM profile that used to
 * live in its own drawer behind its own list pages.
 *
 * It is a tab, not a drawer, because a lead, a prospect and a customer are
 * one record at three points of one lifecycle: opening a company should never
 * depend on which list you arrived from. Identity (name, email, phone, site)
 * stays on Overview, where every party keeps it — this panel owns only what
 * is genuinely relationship state.
 *
 * Stage is the field that matters. Moving forward is a promotion the server
 * records (and, at `customer`, writes the AR role for); moving backward
 * demands a reason, so the stage history never silently rewinds.
 */

interface StatusOption { id: string; name: string; lifecycle_stage: string; is_default: boolean }
interface Option { id: string; name: string }

interface RelationshipResponse {
  account: {
    profile: Record<string, unknown>
    opportunities: { id: string; opportunity_number: string; title: string }[]
  } | null
  options: { statuses: StatusOption[]; owners: Option[]; territories: Option[]; sources: Option[] }
}

const STAGES = ['lead', 'prospect', 'customer'] as const
type Stage = (typeof STAGES)[number]
const RANK: Record<Stage, number> = { lead: 0, prospect: 1, customer: 2 }

interface FormState {
  lifecycleStage: Stage
  statusId: string
  ownerUserId: string
  territoryId: string
  leadSourceId: string
  industry: string
  category: string
  annualRevenue: string
  employeeCount: string
  qualificationScore: string
  nextActionAt: string
}

const text = (value: unknown): string => (value == null ? '' : String(value))

function toForm(profile: Record<string, unknown>): FormState {
  const stage = String(profile.lifecycle_stage ?? 'lead')
  return {
    lifecycleStage: (STAGES as readonly string[]).includes(stage) ? (stage as Stage) : 'lead',
    statusId: text(profile.status_id),
    ownerUserId: text(profile.owner_user_id),
    territoryId: text(profile.territory_id),
    leadSourceId: text(profile.lead_source_id),
    industry: text(profile.industry),
    category: text(profile.category),
    annualRevenue: text(profile.annual_revenue),
    employeeCount: text(profile.employee_count),
    qualificationScore: text(profile.qualification_score),
    // datetime-local wants `YYYY-MM-DDTHH:mm`, and the stamp arrives as an
    // ISO string or a serialized Date depending on the driver.
    nextActionAt: profile.next_action_at ? String(profile.next_action_at).slice(0, 16) : '',
  }
}

export function PartyRelationshipSection({ partyId, canManage }: { partyId: string; canManage: boolean }) {
  const t = useTranslations('crm')
  const tc = useTranslations('common')
  const router = useRouter()
  const { busy, refusal, execute, runExclusive } = useAppAction()
  // Keyed by party so switching accounts reads as "not loaded yet" without a
  // synchronous reset inside the effect body, which would cascade a render on
  // every mount (react-hooks/set-state-in-effect).
  const [result, setResult] = useState<{ partyId: string; body: RelationshipResponse | null } | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [storedStage, setStoredStage] = useState<Stage | null>(null)
  const [stageReason, setStageReason] = useState('')

  // The section's own copy of the relationship: the POST below opens the
  // profile server-side, but nothing re-reads it into this local
  // result/form state — so the empty state (and its Start tracking
  // button) stays visible until the drawer remounts, inviting a second
  // POST. Both the mount effect and startTracking refresh through here.
  // reload fetches and shapes only; the setStates stay at the call sites
  // (the mount effect keeps its promise-chain shape, which never resets
  // state synchronously inside the effect body).
  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/crm/accounts/${partyId}`, { signal })
    if (!response.ok) throw new Error('load failed')
    const body = (await response.json()) as RelationshipResponse
    const form = body.account ? toForm(body.account.profile) : null
    return { result: { partyId, body }, form, storedStage: form?.lifecycleStage ?? null }
  }, [partyId])

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).then(
      (applied) => {
        setResult(applied.result)
        setForm(applied.form)
        setStoredStage(applied.storedStage)
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setResult({ partyId, body: null })
      },
    )
    return () => controller.abort()
  }, [partyId, reload])

  const loaded = result?.partyId === partyId ? result.body : undefined

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current))

  // A stage change retires the previous status: the old value names a status
  // from another stage, which the save endpoint rejects. Fall back to the new
  // stage's default so the panel never sends a stale pairing.
  const changeStage = (next: Stage) => {
    const statuses = loaded?.options.statuses ?? []
    const fallback = statuses.find((status) => status.lifecycle_stage === next && status.is_default)?.id
      ?? statuses.find((status) => status.lifecycle_stage === next)?.id
      ?? ''
    setForm((current) => (current ? { ...current, lifecycleStage: next, statusId: fallback } : current))
  }

  // Opening the profile refreshes this section's own state from a re-read
  // (the POST answers 200, but router.refresh() never touches this
  // component's local result/form state). runExclusive drops a second
  // click landing before busy flips, and the shared busy flag disables
  // the button for the whole flight — so one success renders the profile
  // and retires Start tracking instead of inviting a duplicate POST.
  const startTracking = runExclusive(async () => {
    const ok = await execute(
      () => fetchAction(`/api/crm/accounts/${partyId}`, { method: 'POST' }),
      { fallbackMessage: tc('feedback.saveFailed'), successMessage: tc('feedback.saved') },
    )
    if (!ok) return
    try {
      const applied = await reload()
      setResult(applied.result)
      setForm(applied.form)
      setStoredStage(applied.storedStage)
    } catch {
      // The profile exists server-side; a failed re-read keeps the empty
      // state (and its retryable Start tracking) rather than a dead panel.
    }
    router.refresh()
  })

  async function save() {
    if (!form) return
    const ok = await execute(
      () => fetchAction(`/api/crm/accounts/${partyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...form,
          statusId: form.statusId || null,
          ownerUserId: form.ownerUserId || null,
          territoryId: form.territoryId || null,
          leadSourceId: form.leadSourceId || null,
          nextActionAt: form.nextActionAt || null,
          stageReason: stageReason || null,
          isActive: true,
        }),
      }),
      { fallbackMessage: tc('feedback.saveFailed'), successMessage: tc('feedback.saved') },
    )
    if (ok) router.refresh()
  }

  if (loaded === null) {
    return <div className="py-8 text-center text-sm text-slate-500">{tc('feedback.loadFailed')}</div>
  }
  if (loaded === undefined) {
    return (
      <div className="space-y-4 py-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  // No profile yet: an AR-side or imported customer. Offer to open one rather
  // than pretending the relationship fields exist and failing on save.
  if (!loaded.account || !form) {
    return (
      <section className="space-y-4">
        <ActionAlert error={refusal} fallbackMessage={tc('feedback.saveFailed')} />
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('accounts.untrackedTitle')}</h3>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">{t('accounts.untrackedDescription')}</p>
          {canManage ? (
            <Button className="mt-4" disabled={busy} onClick={startTracking}>
              {busy ? tc('actions.saving') : t('accounts.startTracking')}
            </Button>
          ) : null}
        </div>
      </section>
    )
  }

  const statuses = loaded.options.statuses.filter((status) => status.lifecycle_stage === form.lifecycleStage)
  const movingBackward = storedStage != null && RANK[form.lifecycleStage] < RANK[storedStage]
  const opportunities = loaded.account.opportunities ?? []

  return (
    <section className="space-y-5">
      <ActionAlert error={refusal} fallbackMessage={tc('feedback.saveFailed')} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('accounts.relationshipHeading')}</h3>
          <Badge>{t(`stages.${form.lifecycleStage}`)}</Badge>
        </div>
        {canManage ? (
          <Button size="sm" disabled={busy} onClick={save}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('fields.lifecycleStage')}>
          <Select value={form.lifecycleStage} onChange={(event) => changeStage(event.target.value as Stage)} disabled={!canManage}>
            {STAGES.map((stage) => <option key={stage} value={stage}>{t(`stages.${stage}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('fields.status')}>
          <Select value={form.statusId} onChange={(event) => set('statusId', event.target.value)} disabled={!canManage}>
            <option value="">{tc('labels.none')}</option>
            {statuses.map((status) => (
              <option key={status.id} value={status.id}>
                {displayAccountStatusName(status.name, (key) => t(`accounts.statuses.${key}`))}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('fields.owner')}>
          <Select value={form.ownerUserId} onChange={(event) => set('ownerUserId', event.target.value)} disabled={!canManage}>
            <option value="">{t('fields.unassigned')}</option>
            {loaded.options.owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
          </Select>
        </Field>
        <Field label={t('fields.territory')}>
          <Select value={form.territoryId} onChange={(event) => set('territoryId', event.target.value)} disabled={!canManage}>
            <option value="">{tc('labels.none')}</option>
            {loaded.options.territories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label={t('fields.leadSource')}>
          <Select value={form.leadSourceId} onChange={(event) => set('leadSourceId', event.target.value)} disabled={!canManage}>
            <option value="">{tc('labels.none')}</option>
            {loaded.options.sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label={t('fields.qualificationScore')}>
          <Input type="number" min="0" max="100" value={form.qualificationScore} onChange={(event) => set('qualificationScore', event.target.value)} disabled={!canManage} />
        </Field>
        <Field label={t('fields.industry')}>
          <Input value={form.industry} onChange={(event) => set('industry', event.target.value)} disabled={!canManage} />
        </Field>
        <Field label={t('fields.category')}>
          <Input value={form.category} onChange={(event) => set('category', event.target.value)} disabled={!canManage} />
        </Field>
        <Field label={t('fields.annualRevenue')}>
          <Input inputMode="decimal" value={form.annualRevenue} onChange={(event) => set('annualRevenue', event.target.value)} disabled={!canManage} />
        </Field>
        <Field label={t('fields.employeeCount')}>
          <Input type="number" min="0" value={form.employeeCount} onChange={(event) => set('employeeCount', event.target.value)} disabled={!canManage} />
        </Field>
        <Field label={t('fields.nextAction')}>
          <Input type="datetime-local" value={form.nextActionAt} onChange={(event) => set('nextActionAt', event.target.value)} disabled={!canManage} />
        </Field>
      </div>

      {movingBackward ? (
        <Field label={t('accounts.stageReason')}>
          <Input value={stageReason} onChange={(event) => setStageReason(event.target.value)} disabled={!canManage} />
          <p className="text-xs text-slate-500">{t('accounts.stageReasonHint')}</p>
        </Field>
      ) : null}

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{t('accounts.opportunities')}</h3>
        {opportunities.length ? (
          <div className="divide-y rounded-md border dark:divide-slate-800 dark:border-slate-800">
            {opportunities.slice(0, 10).map((row) => (
              <div key={row.id} className="px-3 py-2 text-sm">{row.opportunity_number} · {row.title}</div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">{t('accounts.noOpportunities')}</p>
        )}
      </section>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>
}
