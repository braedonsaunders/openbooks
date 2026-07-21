'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Badge, Button, Input, Select, cn } from '@openbooks/ui'
import { PagedTable } from '../../../components/paged-table'
import { money } from '../../../lib/format'

export interface TicketListRow {
  id: string
  document_number: string
  status: string
  document_date: string
  total: string
  period: string
  period_start: string
  period_end: string
  signed_at: string | null
  sent_at: string | null
  customer_name: string | null
  project_name: string | null
  project_code: string | null
  foreman_name: string | null
  total_hours: string
}

const STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success' | 'outline'> = {
  draft: 'secondary',
  pending_approval: 'warning',
  approved: 'success',
  voided: 'outline',
}

export function FieldTicketsList(props: {
  tickets: TicketListRow[]
  projects: { id: string; label: string }[]
}) {
  const t = useTranslations('fieldTickets')
  const router = useRouter()
  const [status, setStatus] = useState('')
  const [signature, setSignature] = useState('')
  const [creating, setCreating] = useState(false)
  const [newProject, setNewProject] = useState('')
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  const rows = props.tickets
    .filter((r) => !status || r.status === status)
    .filter((r) => {
      if (!signature) return true
      if (signature === 'signed') return !!r.signed_at
      if (signature === 'waiting') return !!r.sent_at && !r.signed_at
      return !r.sent_at && !r.signed_at
    })

  async function create() {
    if (!newProject) return toast.error(t('list.projectRequired'))
    setBusy(true)
    try {
      const res = await fetch('/api/field-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: newProject, date: newDate }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      router.push(`/field-tickets/${j.id}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const signatureBadge = (r: TicketListRow) => {
    if (r.signed_at) return <Badge variant="success">{t('list.signed')}</Badge>
    if (r.sent_at) return <Badge variant="warning">{t('list.waiting')}</Badge>
    return <span className="text-xs text-slate-400">—</span>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label={t('list.status')} className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('list.allStatuses')}</option>
          <option value="draft">{t('status.draft')}</option>
          <option value="pending_approval">{t('status.pending_approval')}</option>
          <option value="approved">{t('status.approved')}</option>
        </Select>
        <Select aria-label={t('list.signature')} className="w-44" value={signature} onChange={(e) => setSignature(e.target.value)}>
          <option value="">{t('list.allSignatures')}</option>
          <option value="unsigned">{t('list.unsigned')}</option>
          <option value="waiting">{t('list.waiting')}</option>
          <option value="signed">{t('list.signed')}</option>
        </Select>
        <div className="flex-1" />
        {!creating ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> {t('list.new')}
          </Button>
        ) : (
          <div className="flex items-end gap-2">
            <Select aria-label={t('list.project')} className="w-64" value={newProject} onChange={(e) => setNewProject(e.target.value)}>
              <option value="">{t('list.pickProject')}</option>
              {props.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Select>
            <Input aria-label={t('list.date')} type="date" className="w-40" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
            <Button size="sm" onClick={create} disabled={busy}>{t('list.create')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>{t('list.cancel')}</Button>
          </div>
        )}
      </div>

      <PagedTable
        rows={rows}
        rowKey={(r) => r.id}
        searchable
        pageSize={25}
        empty={
          <div className="py-10 text-center">
            <p className="text-sm text-slate-400">{t('list.empty')}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setCreating(true)}>
              <Plus size={14} /> {t('list.new')}
            </Button>
          </div>
        }
        columns={[
          {
            key: 'number',
            header: t('list.number'),
            cell: (r) => (
              <Link href={`/field-tickets/${r.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                {r.document_number}
              </Link>
            ),
            search: (r) => r.document_number,
          },
          {
            key: 'project',
            header: t('list.project'),
            cell: (r) => (r.project_code ? `${r.project_code} · ${r.project_name}` : r.project_name ?? '—'),
            search: (r) => `${r.project_code ?? ''} ${r.project_name ?? ''}`,
          },
          { key: 'customer', header: t('list.customer'), cell: (r) => r.customer_name ?? '—', search: (r) => r.customer_name ?? '' },
          {
            key: 'period',
            header: t('list.period'),
            cell: (r) => (
              <span className="tabular-nums text-xs">
                {r.period === 'weekly' ? `${r.period_start} → ${r.period_end}` : r.period_start}
                <span className={cn('ml-1.5 rounded px-1 py-0.5 text-[10px] uppercase tracking-wide', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}>
                  {t(`period.${r.period}`)}
                </span>
              </span>
            ),
          },
          { key: 'foreman', header: t('list.foreman'), cell: (r) => r.foreman_name ?? '—', search: (r) => r.foreman_name ?? '' },
          { key: 'hours', header: t('list.hours'), cell: (r) => <span className="tabular-nums">{Number(r.total_hours).toFixed(1)}</span> },
          { key: 'total', header: t('list.itemsTotal'), cell: (r) => <span className="tabular-nums">{money(r.total)}</span> },
          {
            key: 'status',
            header: t('list.status'),
            cell: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>{t(`status.${r.status}`)}</Badge>,
          },
          { key: 'signature', header: t('list.signature'), cell: signatureBadge },
        ]}
      />
    </div>
  )
}
