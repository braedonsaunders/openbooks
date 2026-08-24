'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { toast } from 'sonner'

export function ActivityDrawer({ data, owners, accounts, opportunities, closeHref, canManage }: { data: any; owners: any[]; accounts: unknown[]; opportunities: any[]; closeHref: string; canManage: boolean }) {
  const t = useTranslations('crm')
  const tc = useTranslations('common')
  const router = useRouter()
  const row = data.activity
  const link = data.links[0]
  const [form, setForm] = useState({ kind: row.kind, status: row.status, priority: row.priority, subject: row.subject === 'New activity' ? '' : row.subject, body: row.body ?? '', assignedUserId: row.assigned_user_id ?? '', startsAt: row.starts_at ? String(row.starts_at).slice(0, 16) : '', endsAt: row.ends_at ? String(row.ends_at).slice(0, 16) : '', dueAt: row.due_at ? String(row.due_at).slice(0, 16) : '', subjectKind: link?.subject_kind ?? 'account', subjectId: link?.subject_id ?? '' })
  const [busy, setBusy] = useState(false)
  const set = (key: string, value: unknown) => setForm((current) => ({ ...current, [key]: value }))
  async function save() {
    if (!form.subject.trim()) return toast.error(t('validation.subjectRequired'))
    setBusy(true)
    try {
      const response = await fetch(`/api/crm/activities/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...form, assignedUserId: form.assignedUserId || null, startsAt: form.startsAt || null, endsAt: form.endsAt || null, dueAt: form.dueAt || null, links: form.subjectId ? [{ subjectKind: form.subjectKind, subjectId: form.subjectId }] : [] }) })
      if (!response.ok) throw new Error()
      toast.success(tc('feedback.saved')); router.refresh()
    } catch { toast.error(tc('feedback.saveFailed')) } finally { setBusy(false) }
  }
  const related = form.subjectKind === 'opportunity' ? opportunities : accounts
  return <UrlDrawer open closeHref={closeHref} size="lg" title={<span className="flex items-center gap-2">{form.subject || t('activities.newFallback')}<Badge>{t(`activityKinds.${form.kind}`)}</Badge></span>} headerActions={canManage ? <Button onClick={save} disabled={busy}>{busy ? tc('actions.saving') : tc('actions.save')}</Button> : undefined}>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('fields.activityType')}><Select value={form.kind} onChange={(e) => set('kind', e.target.value)} disabled={!canManage}>{['task','call','event','email','note'].map((v) => <option key={v} value={v}>{t(`activityKinds.${v}`)}</option>)}</Select></Field>
      <Field label={t('fields.status')}><Select value={form.status} onChange={(e) => set('status', e.target.value)} disabled={!canManage}>{['planned','in_progress','completed','cancelled'].map((v) => <option key={v} value={v}>{t(`activityStatuses.${v}`)}</option>)}</Select></Field>
      <div className="sm:col-span-2"><Field label={t('fields.subject')}><Input value={form.subject} onChange={(e) => set('subject', e.target.value)} disabled={!canManage} /></Field></div>
      <Field label={t('fields.priority')}><Select value={form.priority} onChange={(e) => set('priority', e.target.value)} disabled={!canManage}>{['low','normal','high','urgent'].map((v) => <option key={v} value={v}>{t(`priorities.${v}`)}</option>)}</Select></Field>
      <Field label={t('fields.assignedTo')}><Select value={form.assignedUserId} onChange={(e) => set('assignedUserId', e.target.value)} disabled={!canManage}><option value="">{t('fields.unassigned')}</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.start')}><Input type="datetime-local" value={form.startsAt} onChange={(e) => set('startsAt', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.end')}><Input type="datetime-local" value={form.endsAt} onChange={(e) => set('endsAt', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.due')}><Input type="datetime-local" value={form.dueAt} onChange={(e) => set('dueAt', e.target.value)} disabled={!canManage} /></Field>
      <Field label={t('fields.relatedType')}><Select value={form.subjectKind} onChange={(e) => { set('subjectKind', e.target.value); set('subjectId', '') }} disabled={!canManage}><option value="account">{t('relatedTypes.account')}</option><option value="opportunity">{t('relatedTypes.opportunity')}</option></Select></Field>
      <Field label={t('fields.relatedRecord')}><Select value={form.subjectId} onChange={(e) => set('subjectId', e.target.value)} disabled={!canManage}><option value="">{tc('labels.none')}</option>{related.map((o) => <option key={o.id} value={o.id}>{o.name ?? `${o.opportunity_number} · ${o.title}`}</option>)}</Select></Field>
      <div className="sm:col-span-2"><Field label={t('fields.notes')}><Textarea rows={8} value={form.body} onChange={(e) => set('body', e.target.value)} disabled={!canManage} /></Field></div>
    </div>
  </UrlDrawer>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div> }
