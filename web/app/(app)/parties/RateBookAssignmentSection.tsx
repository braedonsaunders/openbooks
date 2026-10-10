'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionError, kindForStatus, transportError } from '@braedonsaunders/appkit-errors'
import { Alert, Badge, Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistPager } from '@/components/drawer-sublist'
import { useAppAction } from '@/lib/use-app-action'
import { confirmDialog } from '@/lib/confirm'

interface RateBook {
  id: string; name: string; currency: string; is_default: boolean; latest_version_id: string | null
  versions?: { id: string; effective_from: string; effective_to: string | null }[]
}
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
  pinned_rate_version_id?: string | null
}

const field = 'space-y-1.5'

/**
 * Effective-dated rate-book override for one customer or project, re-homed from
 * the Setup workspace onto the record. Lists assignments via
 * /api/rate-book-assignments, whose native writes enforce project permissions,
 * tenant and subsidiary scope, version ownership and date-overlap rules.
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
  const { busy, execute } = useAppAction()
  const [failure, setFailure] = useState<string | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [canOpenPricing, setCanOpenPricing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [perPage, setPerPage] = useState(5)
  const [form, setForm] = useState<{ id: string | null; rateBookId: string; rateVersionId: string; effectiveFrom: string; effectiveTo: string; dateBasis:'usage_date'|'project_start'; isActive: boolean } | null>(null)
  const loadGeneration = useRef(0)

  const scopeParam = scope === 'customer' ? `customerId=${scopeId}` : `projectId=${scopeId}`
  const scopeBody = scope === 'customer' ? { customerId: scopeId } : { projectId: scopeId }

  async function assignmentAction(url: string, init: RequestInit) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { errorCode?: unknown }
        const code = typeof payload.errorCode === 'string' ? payload.errorCode : 'save'
        const key = t.has(`errors.${code}` as never) ? `errors.${code}` : 'errors.save'
        return {
          ok: false as const,
          error: new ActionError({ kind: kindForStatus(res.status), status: res.status, code, serverMessage: t(key as never) }),
        }
      }
      return { ok: true as const, status: res.status, data: await res.json().catch(() => ({})) }
    } catch (error) {
      return { ok: false as const, error: transportError(error instanceof Error ? error.message : String(error)) }
    }
  }

  async function load(generation = ++loadGeneration.current) {
    if (generation !== loadGeneration.current) return
    try {
      const params = new URLSearchParams(scopeParam)
      if (q.trim()) params.set('q', q.trim())
      params.set('status', status)
      params.set('page', String(page))
      const res = await fetch(`/api/rate-book-assignments?${params}`)
      if (generation !== loadGeneration.current) return
      if (res.status === 403 || res.status === 404) {
        setLoadError(false)
        setVisible(false)
        return
      }
      if (!res.ok) throw new Error('rate book assignments could not be loaded')
      const data = (await res.json()) as { rateBooks: RateBook[]; assignments: Assignment[]; total: number; page: number; perPage: number; canManage: boolean; canOpenPricing: boolean }
      if (generation !== loadGeneration.current) return
      setRateBooks(data.rateBooks)
      setAssignments(data.assignments)
      setTotal(data.total)
      setPerPage(data.perPage)
      setCanManage(data.canManage)
      setCanOpenPricing(data.canOpenPricing)
      setLoadError(false)
      setVisible(true)
    } catch {
      if (generation === loadGeneration.current) setLoadError(true)
    }
  }
  useEffect(() => {
    const generationRef = loadGeneration
    const generation = ++generationRef.current
    const timer = window.setTimeout(() => void load(generation), q ? 200 : 0)
    return () => {
      window.clearTimeout(timer)
      if (generationRef.current === generation) generationRef.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopeId, q, status, page])
  // A read-only viewer must never hold the form open. Adjusted during render
  // (same committed value, no extra render).
  if (!editable && form !== null) setForm(null)

  function startNew() {
    setForm({
      id: null,
      rateBookId: rateBooks.find((b) => b.is_default)?.id ?? rateBooks[0]?.id ?? '',
      rateVersionId: '',
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
      rateVersionId: a.pinned_rate_version_id ?? '',
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
    const body: Record<string, unknown> = {
      ...scopeBody,
      rateBookId: form.rateBookId,
      rateVersionId: form.rateVersionId || null,
      effectiveFrom: form.effectiveFrom || null,
      effectiveTo: form.effectiveTo || null,
      dateBasis: form.dateBasis,
      isActive: form.isActive,
    }
    if (form.id) body.id = form.id
    setFailure(null)
    const fallbackMessage = t('errors.save')
    await execute(() => assignmentAction('/api/rate-book-assignments', {
      method: form.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), {
      fallbackMessage,
      onRefused: (error) => setFailure(error.displayMessage(fallbackMessage)),
      onOk: () => {
        toast.success(form.id ? common('feedback.saved') : t('created'))
        setForm(null)
        void load()
      },
    })
  }

  async function remove(id: string) {
    if (!(await confirmDialog(t('confirmDelete')))) return
    setFailure(null)
    const fallbackMessage = t('errors.save')
    await execute(() => assignmentAction(`/api/rate-book-assignments?id=${encodeURIComponent(id)}`, { method: 'DELETE' }), {
      fallbackMessage,
      onRefused: (error) => setFailure(error.displayMessage(fallbackMessage)),
      onOk: () => {
        toast.success(common('feedback.deleted'))
        void load()
      },
    })
  }

  if (!visible && !loadError) return null
  if (!visible) {
    return (
      <section className="mt-4 space-y-3" aria-label={t('title')}>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h4>
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <span>{t('loadFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>{common('actions.retry')}</Button>
        </div>
      </section>
    )
  }
  const canEditAssignments = canManage && editable
  const versions = rateBooks.find(book => book.id === form?.rateBookId)?.versions ?? []
  const pages = Math.max(1, Math.ceil(total / perPage))
  const pricingHref = (versionId: string) => {
    const returnQuery = searchParams.toString()
    const returnHref = returnQuery ? `${pathname}?${returnQuery}` : pathname
    return `/admin/setup/labor-pricing?card=${versionId}&drawerReturn=${encodeURIComponent(returnHref)}`
  }

  return (
    <DrawerSublist
      title={t('title')}
      description={t(`hint.${scope}`)}
      action={canEditAssignments && rateBooks.length > 0 ? <SublistAddButton label={t('new')} onClick={startNew} disabled={busy} /> : undefined}
      alert={(
        <>
          {!form && failure ? <Alert variant="destructive">{failure}</Alert> : null}
          {loadError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
              <span>{t('staleLoadFailed')}</span>
              <Button size="sm" variant="outline" onClick={() => void load()}>{common('actions.retry')}</Button>
            </div>
          ) : null}
        </>
      )}
      search={{ value: q, onChange: (value) => { setQ(value); setPage(1) }, placeholder: t('search') }}
      filters={(
        <Select value={status} onChange={(event) => { setStatus(event.target.value as 'active' | 'inactive' | 'all'); setPage(1) }} className="w-auto min-w-40" aria-label={t('statusFilter')}>
          <option value="active">{t('status.active')}</option>
          <option value="inactive">{t('status.inactive')}</option>
          <option value="all">{t('status.all')}</option>
        </Select>
      )}
      footer={total > 0 ? (
        <SublistPager count={t('count', { count: total })} page={page} pages={pages} onPage={setPage} disabled={busy} />
      ) : null}
    >
      {assignments.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <SharedTableRow>
                <SharedTableHead className="px-3 py-2 font-medium">{t('rateBook')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 font-medium">{t('effectiveFrom')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 font-medium">{t('effectiveTo')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 font-medium">{t('dateBasis')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 font-medium">{common('labels.status')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2" />
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {assignments.map((a) => (
                <SharedTableRow key={a.id} className="border-t border-slate-100 dark:border-slate-800/60">
                  <SharedTableCell className="px-3 py-2">{a.rate_book_name} <span className="text-slate-400">· {a.currency}</span></SharedTableCell>
                  <SharedTableCell className="px-3 py-2 tabular-nums">{a.effective_from ? String(a.effective_from).slice(0, 10) : '—'}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2 tabular-nums">{a.effective_to ? String(a.effective_to).slice(0, 10) : '—'}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2">{t(`dateBasisOptions.${a.date_basis}`)}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2">
                    <Badge variant={a.is_active ? 'success' : 'outline'}>
                      {a.is_active ? common('status.active') : common('status.inactive')}
                    </Badge>
                  </SharedTableCell>
                  <SharedTableCell className="px-3 py-2 text-right">
                    {a.rate_version_id && canOpenPricing ? <Link href={pricingHref(a.rate_version_id) as never} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{t('openPricing')}</Link> : null}
                    {canEditAssignments ? <button type="button" onClick={() => startEdit(a)} disabled={busy} className="ml-3 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{common('actions.edit')}</button> : null}
                    {canEditAssignments ? <button type="button" onClick={() => remove(a.id)} disabled={busy} className="ml-3 text-xs font-medium text-red-600 hover:underline dark:text-red-400">{common('actions.delete')}</button> : null}
                  </SharedTableCell>
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </div>
      ) : (
        <SublistEmpty text={t('empty')} hint={rateBooks.length === 0 ? t('noBooks') : undefined} />
      )}

      <Drawer
        open={form !== null}
        onClose={() => { if (!busy) setForm(null) }}
        stacked
        size="md"
        title={form?.id ? t('editTitle') : t('new')}
        footer={form ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => setForm(null)}>{common('actions.cancel')}</Button>
            <Button disabled={busy} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button>
          </>
        ) : undefined}
      >
        {form ? (
          <div className="space-y-4" inert={busy}>
            {failure ? <Alert variant="destructive">{failure}</Alert> : null}
            <div className={field}>
              <Label>{t('rateBook')}</Label>
              <Select value={form.rateBookId} onChange={(e) => setForm({ ...form, rateBookId: e.target.value })}>
                {rateBooks.map((b) => (
                  <option key={b.id} value={b.id}>{b.name} · {b.currency}</option>
                ))}
              </Select>
            </div>
            <div className={field}>
              <Label help={t('rateVersionHelp')}>{t('rateVersion')}</Label>
              <Select name="rateVersionId" aria-label={t('rateVersion')} value={form.rateVersionId} onChange={(e) => setForm({ ...form, rateVersionId: e.target.value })}>
                <option value="">{t('automaticVersion')}</option>
                {form.rateVersionId && !versions.some(version => version.id === form.rateVersionId) ? (
                  <option value={form.rateVersionId}>{t('unavailableVersion')}</option>
                ) : null}
                {versions.map(version => (
                  <option key={version.id} value={version.id}>
                    {String(version.effective_from).slice(0, 10)} · {version.effective_to ? String(version.effective_to).slice(0, 10) : t('openEnded')}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className={field}>
                <Label>{t('effectiveFrom')}</Label>
                <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
              </div>
              <div className={field}>
                <Label>{t('effectiveTo')}</Label>
                <Input type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
              </div>
              <div className={field}>
                <Label>{t('dateBasis')}</Label>
                <Select value={form.dateBasis} onChange={(e)=>setForm({...form,dateBasis:e.target.value as 'usage_date'|'project_start'})}>
                  <option value="usage_date">{t('dateBasisOptions.usage_date')}</option>
                  <option value="project_start">{t('dateBasisOptions.project_start')}</option>
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
              {common('status.active')}
            </label>
          </div>
        ) : null}
      </Drawer>
    </DrawerSublist>
  )
}
