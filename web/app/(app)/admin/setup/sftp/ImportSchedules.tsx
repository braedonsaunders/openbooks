'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { confirmDialog } from '../../../../../lib/confirm'

interface Sched {
  id: string
  server_name: string
  account_number: string | null
  account_name: string
  format: string
  folder: string
  is_active: boolean
  last_run_at: string | null
  last_result: { imported?: number; filesSeen?: number; errors?: string[] } | null
}
interface Opt { id: string; name?: string; label?: string }

const FORMATS = ['auto', 'ofx', 'csv', 'camt053', 'bai2', 'mt940']

export function ImportSchedules({ schedules, servers, accounts }: { schedules: Sched[]; servers: Opt[]; accounts: Opt[] }) {
  const t = useTranslations('banking.sftp.schedules')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [serverId, setServerId] = useState(servers[0]?.id ?? '')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [format, setFormat] = useState('auto')
  const [folder, setFolder] = useState('inbound')

  async function create() {
    if (!serverId || !accountId) return
    setBusy(true)
    try {
      const res = await fetch('/api/banking/sftp/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sftpServerId: serverId, accountId, format, folder }) })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('createFailed')); return }
      toast.success(t('created')); setCreating(false); router.refresh()
    } finally { setBusy(false) }
  }
  async function runNow(s: Sched) {
    setBusy(true)
    try {
      const res = await fetch(`/api/banking/sftp/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run' }) })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('runFailed')); return }
      const r = data.result
      toast.success(t('ran', { imported: r.imported ?? 0, files: r.filesSeen ?? 0 }))
      router.refresh()
    } finally { setBusy(false) }
  }
  async function toggle(s: Sched) {
    await fetch(`/api/banking/sftp/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !s.is_active }) })
    router.refresh()
  }
  async function remove(s: Sched) {
    if (!(await confirmDialog({ message: t('deleteConfirm'), tone: 'danger' }))) return
    await fetch(`/api/banking/sftp/schedules/${s.id}`, { method: 'DELETE' })
    toast.success(t('deleted')); router.refresh()
  }

  const canCreate = servers.length > 0 && accounts.length > 0

  return (
    <div className="space-y-3 border-t border-slate-200 pt-5 dark:border-slate-800">
      <div className="flex items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <CalendarClock size={15} className="text-teal-600 dark:text-teal-400" /> {t('title')}
        </h3>
        <Button variant="outline" size="sm" disabled={!canCreate} onClick={() => setCreating(true)}><Plus size={14} /> {t('newSchedule')}</Button>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>

      {schedules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-5 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{t('empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('server')}</TableHead>
              <TableHead>{tCommon('labels.account')}</TableHead>
              <TableHead>{t('folder')}</TableHead>
              <TableHead>{t('format')}</TableHead>
              <TableHead>{t('lastRun')}</TableHead>
              <TableHead>{tCommon('labels.status')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.server_name}</TableCell>
                <TableCell><span className="font-mono text-[13px]">{s.account_number}</span> <span className="text-slate-500 dark:text-slate-400">{s.account_name}</span></TableCell>
                <TableCell className="font-mono text-xs">{s.folder}/</TableCell>
                <TableCell><Badge variant="outline">{s.format}</Badge></TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">
                  {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : '—'}
                  {s.last_result ? <span className="ml-1 text-xs">({t('importedN', { n: s.last_result.imported ?? 0 })})</span> : null}
                </TableCell>
                <TableCell>{s.is_active ? <Badge variant="success">{tCommon('labels.active')}</Badge> : <Badge variant="secondary">{t('paused')}</Badge>}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" disabled={busy} title={t('runNow')} onClick={() => runNow(s)}><Play size={14} /></Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle(s)}>{s.is_active ? t('pause') : t('resume')}</Button>
                    <Button variant="ghost" size="sm" disabled={busy} className="text-red-600 dark:text-red-400" title={tCommon('actions.delete')} onClick={() => remove(s)}><Trash2 size={14} /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Drawer open={creating} onClose={() => setCreating(false)} size="sm" title={t('newSchedule')} description={t('newScheduleHint')}
        headerActions={<>
          <Button variant="outline" onClick={() => setCreating(false)}>{tCommon('actions.cancel')}</Button>
          <Button disabled={busy || !serverId || !accountId} onClick={create}>{busy ? tCommon('actions.creating') : tCommon('actions.create')}</Button>
        </>}>
        <div className="space-y-4 p-1">
          <div className="space-y-1.5"><Label>{t('server')}</Label>
            <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>{servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </div>
          <div className="space-y-1.5"><Label>{tCommon('labels.account')}</Label>
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>{t('format')}</Label>
              <Select value={format} onChange={(e) => setFormat(e.target.value)}>{FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}</Select>
            </div>
            <div className="space-y-1.5"><Label>{t('folder')}</Label>
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('formatHint')}</p>
        </div>
      </Drawer>
    </div>
  )
}
