'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { toast } from 'sonner'

type Option = { id: string; name: string; lifecycle_stage?: string }

export function AccountDrawer({ data, statuses, owners, territories, sources, basePath, canManage }: {
  data: any
  statuses: Option[]
  owners: Option[]
  territories: Option[]
  sources: Option[]
  basePath: string
  canManage: boolean
}) {
  const t = useTranslations('crm')
  const tc = useTranslations('common')
  const router = useRouter()
  const party = data.party
  const profile = data.crm.profile
  const [form, setForm] = useState({
    displayName: party.display_name === 'New lead' ? '' : party.display_name,
    email: party.email ?? '', phone: party.phone ?? '', website: party.website ?? '',
    lifecycleStage: profile.lifecycle_stage, statusId: profile.status_id ?? '', ownerUserId: profile.owner_user_id ?? '',
    territoryId: profile.territory_id ?? '', leadSourceId: profile.lead_source_id ?? '', industry: profile.industry ?? '',
    category: profile.category ?? '', annualRevenue: profile.annual_revenue ?? '', employeeCount: profile.employee_count ?? '',
    qualificationScore: profile.qualification_score ?? '', nextActionAt: profile.next_action_at ? String(profile.next_action_at).slice(0, 16) : '',
  })
  const [busy, setBusy] = useState(false)
  const set = (key: string, value: unknown) => setForm((current) => ({ ...current, [key]: value }))
  async function save() {
    if (!form.displayName.trim()) return toast.error(t('validation.nameRequired'))
    setBusy(true)
    try {
      const identity = await fetch(`/api/parties/${party.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: form.displayName, email: form.email, phone: form.phone, website: form.website, isActive: true }) })
      const crm = await fetch(`/api/crm/accounts/${party.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...form, statusId: form.statusId || null, ownerUserId: form.ownerUserId || null, territoryId: form.territoryId || null, leadSourceId: form.leadSourceId || null, nextActionAt: form.nextActionAt || null, isActive: true }) })
      if (!identity.ok || !crm.ok) throw new Error()
      toast.success(tc('feedback.saved'))
      router.refresh()
    } catch { toast.error(tc('feedback.saveFailed')) } finally { setBusy(false) }
  }
  const filteredStatuses = statuses.filter((status) => status.lifecycle_stage === form.lifecycleStage)
  return <UrlDrawer open closeHref={basePath} size="xl" title={<span className="flex items-center gap-2">{form.displayName || t('accounts.newFallback')}<Badge>{t(`stages.${form.lifecycleStage}`)}</Badge></span>} headerActions={canManage ? <Button onClick={save} disabled={busy}>{busy ? tc('actions.saving') : tc('actions.save')}</Button> : undefined}>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('fields.accountName')}><Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.lifecycleStage')}><Select value={form.lifecycleStage} onChange={(e) => set('lifecycleStage', e.target.value)} disabled={!canManage}><option value="lead">{t('stages.lead')}</option><option value="prospect">{t('stages.prospect')}</option><option value="customer">{t('stages.customer')}</option></Select></Field>
      <Field label={t('fields.status')}><Select value={form.statusId} onChange={(e) => set('statusId', e.target.value)} disabled={!canManage}><option value="">{tc('labels.none')}</option>{filteredStatuses.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.owner')}><Select value={form.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)} disabled={!canManage}><option value="">{tc('labels.unassigned')}</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.territory')}><Select value={form.territoryId} onChange={(e) => set('territoryId', e.target.value)} disabled={!canManage}><option value="">{tc('labels.none')}</option>{territories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.leadSource')}><Select value={form.leadSourceId} onChange={(e) => set('leadSourceId', e.target.value)} disabled={!canManage}><option value="">{tc('labels.none')}</option>{sources.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={tc('labels.email')}><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.phone')}><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.website')}><Input value={form.website} onChange={(e) => set('website', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.industry')}><Input value={form.industry} onChange={(e) => set('industry', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.category')}><Input value={form.category} onChange={(e) => set('category', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.annualRevenue')}><Input inputMode="decimal" value={form.annualRevenue} onChange={(e) => set('annualRevenue', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.employeeCount')}><Input type="number" min="0" value={form.employeeCount} onChange={(e) => set('employeeCount', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.qualificationScore')}><Input type="number" min="0" max="100" value={form.qualificationScore} onChange={(e) => set('qualificationScore', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.nextAction')}><Input type="datetime-local" value={form.nextActionAt} onChange={(e) => set('nextActionAt', e.target.value)} disabled={!canManage} /></Field>
    </div>
    <Related title={t('accounts.activities')} rows={data.crm.activities} empty={t('accounts.noActivities')} value={(row) => row.subject} />
    <Related title={t('accounts.opportunities')} rows={data.crm.opportunities} empty={t('accounts.noOpportunities')} value={(row) => `${row.opportunity_number} · ${row.title}`} />
  </UrlDrawer>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div> }
function Related({ title, rows, empty, value }: { title: string; rows: any[]; empty: string; value: (row: any) => string }) { return <section className="mt-7"><h3 className="mb-2 font-semibold">{title}</h3>{rows.length ? <div className="divide-y rounded-md border dark:divide-slate-800 dark:border-slate-800">{rows.slice(0, 10).map((row) => <div key={row.id} className="px-3 py-2 text-sm">{value(row)}</div>)}</div> : <p className="text-sm text-slate-500">{empty}</p>}</section> }
