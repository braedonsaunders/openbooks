'use client'

import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Copy, KeyRound, Plus, RotateCcw, Server, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@openbooks/ui'
import { confirmDialog } from '../../../../../lib/confirm'

interface Srv {
  id: string
  name: string
  username: string
  backend: string
  bucket: string | null
  root_prefix: string
  is_active: boolean
  last_connected_at: string | null
}

interface Creds { username: string; password: string; rootPrefix?: string }
interface Daemon { enabled: boolean; port: number; host: string; advertisedHost: string | null; fingerprint: string }

export function SftpManager({ servers, daemon, empty, show = 'all' }: { servers: Srv[]; daemon: Daemon; empty?: ReactNode; show?: 'all' | 'daemon' | 'servers' }) {
  const t = useTranslations('banking.sftp')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [keys, setKeys] = useState('')
  const [creds, setCreds] = useState<Creds | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [enabled, setEnabled] = useState(daemon.enabled)
  const [port, setPort] = useState(String(daemon.port))
  const [advertisedHost, setAdvertisedHost] = useState(daemon.advertisedHost ?? '')

  async function saveSettings() {
    setBusy(true)
    try {
      const res = await fetch('/api/banking/sftp/daemon', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, port: Number(port) || 2222, advertisedHost: advertisedHost.trim() || null }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('settingsFailed')); return }
      toast.success(t('settingsSaved'))
      setSettingsOpen(false)
      router.refresh()
    } finally { setBusy(false) }
  }

  async function create() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/banking/sftp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, authorizedKeys: keys.trim() || undefined }) })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('createFailed')); return }
      setCreds({ username: data.username, password: data.password, rootPrefix: data.rootPrefix })
      setCreating(false)
      setName('')
      router.refresh()
    } finally { setBusy(false) }
  }

  async function rotate(s: Srv) {
    const res = await fetch(`/api/banking/sftp/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rotate' }) })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error ?? t('rotateFailed')); return }
    setCreds({ username: data.username, password: data.password })
  }

  async function toggle(s: Srv) {
    await fetch(`/api/banking/sftp/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !s.is_active }) })
    router.refresh()
  }

  async function remove(s: Srv) {
    if (!(await confirmDialog({ message: t('deleteConfirm', { name: s.name }), tone: 'danger' }))) return
    await fetch(`/api/banking/sftp/${s.id}`, { method: 'DELETE' })
    toast.success(t('deleted'))
    router.refresh()
  }

  const connStr = `sftp -P ${daemon.port} <username>@${daemon.host}`

  return (
    <div className="space-y-4">
      {/* the endpoint — the single shared SFTP server clients connect to (all from the DB, no env) */}
      {show !== 'servers' && (
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Server size={15} className="text-teal-600 dark:text-teal-400" /> {t('endpointTitle')}
            {daemon.enabled ? <Badge variant="success">{t('running')}</Badge> : <Badge variant="secondary">{t('disabled')}</Badge>}
          </div>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}><Settings2 size={14} /> {t('settings')}</Button>
        </div>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('endpointHint')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <ConnField label={t('host')} value={daemon.host} copyable />
          <ConnField label={t('port')} value={String(daemon.port)} copyable />
          <ConnField label={t('fingerprint')} value={daemon.fingerprint || '—'} copyable={!!daemon.fingerprint} />
        </div>
        <div className="mt-3">
          <ConnField label={t('connectCommand')} value={connStr} copyable />
        </div>
      </div>

      )}

      {/* logins — per-partner credentials the endpoint authenticates */}
      {show !== 'daemon' && (<>
      <div className="flex items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <KeyRound size={15} className="text-teal-600 dark:text-teal-400" /> {t('loginsTitle')}
        </h3>
        <Button onClick={() => setCreating(true)}><Plus size={15} /> {t('newServer')}</Button>
      </div>

      {servers.length === 0 ? empty : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tCommon('labels.name')}</TableHead>
              <TableHead>{t('username')}</TableHead>
              <TableHead>{t('backendLabel')}</TableHead>
              <TableHead>{t('root')}</TableHead>
              <TableHead>{tCommon('labels.status')}</TableHead>
              <TableHead>{t('lastConnected')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {servers.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium"><Server size={13} className="mr-1.5 inline text-slate-400" />{s.name}</TableCell>
                <TableCell className="font-mono text-[13px]">{s.username}</TableCell>
                <TableCell><Badge variant="outline">{s.backend === 's3' ? t('backendS3') : t('backendLocal')}</Badge></TableCell>
                <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">{s.bucket ? `${s.bucket}/` : ''}{s.root_prefix}</TableCell>
                <TableCell>{s.is_active ? <Badge variant="success">{tCommon('labels.active')}</Badge> : <Badge variant="secondary">{t('inactive')}</Badge>}</TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">{s.last_connected_at ? new Date(s.last_connected_at).toLocaleString() : '—'}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" disabled={busy} title={t('rotate')} onClick={() => rotate(s)}><RotateCcw size={14} /></Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle(s)}>{s.is_active ? t('disable') : t('enable')}</Button>
                    <Button variant="ghost" size="sm" disabled={busy} className="text-red-600 dark:text-red-400" title={tCommon('actions.delete')} onClick={() => remove(s)}><Trash2 size={14} /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* create drawer */}
      <Drawer open={creating} onClose={() => setCreating(false)} size="sm" title={t('newServer')} description={t('newServerHint')}
        headerActions={<>
          <Button variant="outline" onClick={() => setCreating(false)}>{tCommon('actions.cancel')}</Button>
          <Button disabled={busy || !name.trim()} onClick={create}>{busy ? tCommon('actions.creating') : t('create')}</Button>
        </>}>
        <div className="space-y-1.5 p-1">
          <Label>{tCommon('labels.name')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('createNote')}</p>
          <div className="mt-3 space-y-1.5">
            <Label>{t('authorizedKeys')}</Label>
            <Textarea value={keys} onChange={(e) => setKeys(e.target.value)} rows={3} spellCheck={false} placeholder={t('authorizedKeysPlaceholder')} className="font-mono text-xs" />
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('authorizedKeysHint')}</p>
          </div>
        </div>
      </Drawer>

      {/* credentials reveal */}
      <Drawer open={!!creds} onClose={() => setCreds(null)} size="sm" title={t('credsTitle')} description={t('credsHint')}
        headerActions={<Button onClick={() => setCreds(null)}>{tCommon('actions.done')}</Button>}>
        {creds ? (
          <div className="space-y-3 p-1">
            <CredRow label={t('username')} value={creds.username} />
            <CredRow label={t('password')} value={creds.password} />
            {creds.rootPrefix ? <CredRow label={t('root')} value={creds.rootPrefix} /> : null}
            <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <KeyRound size={14} className="mt-0.5 shrink-0" /> {t('credsWarning')}
            </p>
          </div>
        ) : null}
      </Drawer>

      </>)}

      {/* daemon settings — the former env vars, now fully in the UI */}
      <Drawer open={settingsOpen} onClose={() => setSettingsOpen(false)} size="sm" title={t('settingsTitle')} description={t('settingsHint')}
        headerActions={<>
          <Button variant="outline" onClick={() => setSettingsOpen(false)}>{tCommon('actions.cancel')}</Button>
          <Button disabled={busy} onClick={saveSettings}>{busy ? tCommon('actions.saving') : tCommon('actions.save')}</Button>
        </>}>
        <div className="space-y-4 p-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
            {t('enableDaemon')}
          </label>
          <div className="space-y-1.5">
            <Label>{t('port')}</Label>
            <Input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} className="w-32" />
          </div>
          <div className="space-y-1.5">
            <Label>{t('advertisedHost')}</Label>
            <Input value={advertisedHost} onChange={(e) => setAdvertisedHost(e.target.value)} placeholder={t('advertisedHostPlaceholder')} />
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('advertisedHostHint')}</p>
          </div>
        </div>
      </Drawer>
    </div>
  )
}

function ConnField({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const t = useTranslations('banking.sftp')
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1.5 font-mono text-[13px] dark:bg-slate-800" title={value}>{value}</code>
        {copyable ? (
          <Button variant="outline" size="sm" title={t('copyField', { label })}
            onClick={() => { navigator.clipboard?.writeText(value); toast.success(t('copied', { label })) }}>
            <Copy size={14} />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function CredRow({ label, value }: { label: string; value: string }) {
  const t = useTranslations('common')
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1.5 font-mono text-[13px] dark:bg-slate-800">{value}</code>
        <Button variant="outline" size="sm" onClick={() => { navigator.clipboard?.writeText(value); toast.success(t('actions.copy')) }}>{t('actions.copy')}</Button>
      </div>
    </div>
  )
}
