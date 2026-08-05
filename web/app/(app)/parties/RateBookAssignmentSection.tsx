'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'

interface RateBook { id: string; name: string; currency: string; is_default: boolean; latest_version_id: string | null }
interface Assignment {
  id: string
  rate_book_id: string
  rate_book_name: string
  currency: string
  effective_from: string | null
  effective_to: string | null
  date_basis: 'usage_date'|'project_start'
  is_active: boolean
  rate_version_id: string | null
}

const field = 'space-y-1.5'

/**
 * Effective-dated rate-book override for one customer or project, re-homed from
 * the Setup workspace onto the record. Lists assignments via
 * /api/rate-book-assignments and mutates through the shared setup CRUD API
 * (which enforces scope + date-overlap rules). Hides itself for users without
 * admin.setup.manage (the read endpoint 403s).
 */
export function RateBookAssignmentSection({
  scope,
  scopeId,
  editable = true,
}: {
  scope: 'customer' | 'project'
  scopeId: string
  /** Parent drawer edit state. Permission alone must not make view mode editable. */
  editable?: boolean
}) {
  const t = useTranslations('parties.rateBookAssignments')
  const common = useTranslations('common')
  const pathname = usePathname() ?? '/parties'
  const searchParams = useSearchParams()
  const [visible, setVisible] = useState(false)
  const [rateBooks, setRateBooks] = useState<RateBook[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [busy, setBusy] = useState(false)
  const [canManage, setCanManage] = useState(false)
  const [canOpenPricing, setCanOpenPricing] = useState(false)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [perPage, setPerPage] = useState(5)
  const [form, setForm] = useState<{ id: string | null; rateBookId: string; effectiveFrom: string; effectiveTo: string; dateBasis:'usage_date'|'project_start'; isActive: boolean } | null>(null)

  const scopeParam = scope === 'customer' ? `customerId=${scopeId}` : `projectId=${scopeId}`
  const scopeBody = scope === 'customer' ? { customerId: scopeId } : { projectId: scopeId }

  async function load() {
    const params = new URLSearchParams(scopeParam)
    if (q.trim()) params.set('q', q.trim())
    params.set('status', status)
    params.set('page', String(page))
    const res = await fetch(`/api/rate-book-assignments?${params}`)
    if (res.status === 403 || res.status === 404) {
      setVisible(false)
      return
    }
    if (!res.ok) return
    const data = (await res.json()) as { rateBooks: RateBook[]; assignments: Assignment[]; total: number; page: number; perPage: number; canManage: boolean; canOpenPricing: boolean }
    setRateBooks(data.rateBooks)
    setAssignments(data.assignments)
    setTotal(data.total)
    setPerPage(data.perPage)
    setCanManage(data.canManage)
    setCanOpenPricing(data.canOpenPricing)
    setVisible(true)
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), q ? 200 : 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, q, status, page])
  useEffect(() => {
    if (!editable) setForm(null)
  }, [editable])

  function startNew() {
    setForm({
      id: null,
      rateBookId: rateBooks.find((b) => b.is_default)?.id ?? rateBooks[0]?.id ?? '',
      effectiveFrom: '',
      effectiveTo: '',
      dateBasis: scope === 'customer' ? 'project_start' : 'usage_date',
      isActive: true,
    })
  }
  function startEdit(a: Assignment) {
    setForm({
      id: a.id,
      rateBookId: a.rate_book_id,
      effectiveFrom: a.effective_from ? String(a.effective_from).slice(0, 10) : '',
      effectiveTo: a.effective_to ? String(a.effective_to).slice(0, 10) : '',
      dateBasis: a.date_basis,
      isActive: a.is_active,
    })
  }

  async function save() {
    if (!form) return
    if (!form.rateBookId) {
      toast.error(t('rateBookRequired'))
      return
    }
    setBusy(true)
    const body: Record<string, unknown> = {
      ...scopeBody,
      rateBookId: form.rateBookId,
      effectiveFrom: form.effectiveFrom || null,
      effectiveTo: form.effectiveTo || null,
      dateBasis: form.dateBasis,
      isActive: form.isActive,
    }
    if (form.id) body.id = form.id
    const res = await fetch('/api/rate-book-assignments', {
      method: form.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(t(`errors.${typeof data.errorCode === 'string' ? data.errorCode : 'save'}`))
      return
    }
    toast.success(form.id ? common('feedback.saved') : t('created'))
    setForm(null)
    await load()
  }

  async function remove(id: string) {
    if (!confirm(t('confirmDelete'))) return
    setBusy(true)
    const res = await fetch(`/api/rate-book-assignments?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(t(`errors.${typeof data.errorCode === 'string' ? data.errorCode : 'save'}`))
      return
    }
    toast.success(common('feedback.deleted'))
    await load()
  }

  if (!visible) return null
  const canEditAssignments = canManage && editable
  const pages = Math.max(1, Math.ceil(total / perPage))
  const pricingHref = (versionId: string) => {
    const returnQuery = searchParams.toString()
    const returnHref = returnQuery ? `${pathname}?${returnQuery}` : pathname
    return `/admin/setup/labor-pricing?card=${versionId}&drawerReturn=${encodeURIComponent(returnHref)}`
  }

  return (
    <section className="mt-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t(`hint.${scope}`)}</p>
        </div>
        {!form && canEditAssignments ? (
          <Button variant="outline" size="sm" onClick={startNew} disabled={rateBooks.length === 0}>
            {t('new')}
          </Button>
        ) : null}
      </div>

      {rateBooks.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('noBooks')}</p>
      ) : null}

      {editable ? <div className="flex flex-wrap gap-2">
        <Input
          value={q}
          onChange={(event) => { setQ(event.target.value); setPage(1) }}
          placeholder={t('search')}
          className="min-w-56 flex-1"
        />
        <Select value={status} onChange={(event) => { setStatus(event.target.value as 'active' | 'inactive' | 'all'); setPage(1) }} className="w-auto min-w-40" aria-label={t('statusFilter')}>
          <option value="active">{t('status.active')}</option>
          <option value="inactive">{t('status.inactive')}</option>
          <option value="all">{t('status.all')}</option>
        </Select>
      </div> : null}

      {form ? (
        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className={`${field} lg:col-span-2`}>
              <Label>{t('rateBook')}</Label>
              <Select value={form.rateBookId} onChange={(e) => setForm({ ...form, rateBookId: e.target.value })}>
                {rateBooks.map((b) => (
                  <option key={b.id} value={b.id}>{b.name} · {b.currency}</option>
                ))}
              </Select>
            </div>
            <div className={field}>
              <Label>{t('effectiveFrom')}</Label>
              <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
            </div>
            <div className={field}>
              <Label>{t('dateBasis')}</Label>
              <Select value={form.dateBasis} onChange={(e)=>setForm({...form,dateBasis:e.target.value as 'usage_date'|'project_start'})}>
                <option value="usage_date">{t('dateBasisOptions.usage_date')}</option>
                <option value="project_start">{t('dateBasisOptions.project_start')}</option>
              </Select>
            </div>
            <div className={field}>
              <Label>{t('effectiveTo')}</Label>
              <Input type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-2 lg:col-span-4">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
              {common('status.active')}
            </label>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
              <Button disabled={busy} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button>
              <Button variant="outline" onClick={() => setForm(null)}>{common('actions.cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {assignments.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">{t('rateBook')}</th>
                <th className="px-3 py-2 font-medium">{t('effectiveFrom')}</th>
                <th className="px-3 py-2 font-medium">{t('effectiveTo')}</th>
                <th className="px-3 py-2 font-medium">{t('dateBasis')}</th>
                <th className="px-3 py-2 font-medium">{common('labels.status')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800/60">
                  <td className="px-3 py-2">{a.rate_book_name} <span className="text-slate-400">· {a.currency}</span></td>
                  <td className="px-3 py-2 tabular-nums">{a.effective_from ? String(a.effective_from).slice(0, 10) : '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{a.effective_to ? String(a.effective_to).slice(0, 10) : '—'}</td>
                  <td className="px-3 py-2">{t(`dateBasisOptions.${a.date_basis}`)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={a.is_active ? 'success' : 'outline'}>
                      {a.is_active ? common('status.active') : common('status.inactive')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {a.rate_version_id && canOpenPricing ? <Link href={pricingHref(a.rate_version_id) as never} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{t('openPricing')}</Link> : null}
                    {canEditAssignments ? <button type="button" onClick={() => startEdit(a)} className="ml-3 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{common('actions.edit')}</button> : null}
                    {canEditAssignments ? <button type="button" onClick={() => remove(a.id)} disabled={busy} className="ml-3 text-xs font-medium text-red-600 hover:underline dark:text-red-400">{common('actions.delete')}</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !form ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('empty')}</p>
      ) : null}
      {total > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">{t('count', { count: total })}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || busy} onClick={() => setPage((value) => value - 1)}>{common('actions.previous')}</Button>
            <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages || busy} onClick={() => setPage((value) => value + 1)}>{common('actions.next')}</Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
