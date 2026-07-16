'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plug, RefreshCw, Play, FlaskConical, Trash2, Plus, Pencil } from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'

// --- shapes (mirror the API responses) ---------------------------------------

interface FieldSpec {
  key: string
  label: string
  placeholder?: string
  required?: boolean
  help?: string
  kind?: 'text' | 'select'
  options?: { value: string; label: string }[]
  optionsSource?: 'currencies'
}
interface Currency { code: string; name: string }
interface SourceTypeDef {
  source: string
  displayName: string
  authKind: 'token' | 'oauth2'
  blurb: string
  configFields: FieldSpec[]
  secretFields: FieldSpec[]
}
interface Connection {
  id: string
  source: string
  displayName: string
  authKind: string
  status: 'active' | 'paused' | 'error' | 'unconfigured'
  config: Record<string, unknown>
  mirrorEnabled: boolean
  mirrorSchedule: string
  cursor: string | null
  lastRunAt: string | null
  lastError: string | null
  hasSecrets: boolean
}
interface Run {
  id: string
  connectionId: string | null
  source: string
  kind: string
  status: string
  startedAt: string
  finishedAt: string | null
  stats?: {
    docsNew?: number
    docsAmended?: number
    docsUnchanged?: number
    ordersNew?: number
    docsFailed?: number
    applications?: { inserted?: number } | null
    tb?: { matches?: number; accounts?: number; mismatches?: unknown[] }
    openItems?: { checked?: number; matches?: number; mismatches?: unknown[] } | null
  }
  errorMessage: string | null
  triggeredBy: string | null
}
interface Payload { connections: Connection[]; runs: Run[]; sourceTypes: SourceTypeDef[]; currencies: Currency[] }

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'destructive'> = {
  active: 'success',
  paused: 'secondary',
  error: 'destructive',
  unconfigured: 'secondary',
}

function fmt(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function PlatformClient() {
  const tHub = useTranslations('admin.hub')
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null) // `${id}:${action}`
  const [drawer, setDrawer] = useState<{ editing: Connection | null } | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/platform/connections')
    if (!res.ok) {
      toast.error(`Failed to load connections (HTTP ${res.status})`)
      setLoading(false)
      return
    }
    setData(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])


  async function run(conn: Connection, mode: 'full_migration' | 'mirror') {
    const key = `${conn.id}:${mode}`
    setBusy(key)
    const tid = toast.loading(mode === 'full_migration' ? 'Queuing full migration…' : 'Queuing mirror…')
    try {
      const res = await fetch(`/api/platform/connections/${conn.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(`${mode === 'full_migration' ? 'Migration' : 'Mirror'} queued — runs on the worker`, { id: tid })
      setTimeout(() => void load(), 800)
    } catch (e) {
      toast.error((e as Error).message, { id: tid })
    } finally {
      setBusy(null)
    }
  }

  async function test(conn: Connection) {
    const key = `${conn.id}:test`
    setBusy(key)
    const tid = toast.loading('Testing connection…')
    try {
      const res = await fetch(`/api/platform/connections/${conn.id}/test`, { method: 'POST' })
      const body = await res.json()
      if (body.ok) toast.success(`Connected${body.detail ? ` — ${body.detail}` : ''}`, { id: tid })
      else toast.error(`Connection failed: ${body.error ?? 'unknown error'}`, { id: tid, duration: 8000 })
    } catch (e) {
      toast.error((e as Error).message, { id: tid })
    } finally {
      setBusy(null)
    }
  }

  async function toggleMirror(conn: Connection) {
    setBusy(`${conn.id}:mirror`)
    try {
      await fetch(`/api/platform/connections/${conn.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mirrorEnabled: !conn.mirrorEnabled }),
      })
      await load()
    } finally {
      setBusy(null)
    }
  }

  async function remove(conn: Connection) {
    if (!confirm(`Delete connection "${conn.displayName}"? Migrated data stays; only the link is removed.`)) return
    setBusy(`${conn.id}:del`)
    try {
      await fetch(`/api/platform/connections/${conn.id}`, { method: 'DELETE' })
      await load()
      toast.success('Connection removed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <PageHeader
        back={{ href: '/admin', label: tHub('title') }}
        title="Migrations & Mirror"
        description="Connect an external accounting system, migrate in one click, then mirror it daily to A/B-run both in parallel."
      />

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Connections</h2>
        <Button onClick={() => setDrawer({ editing: null })}>
          <Plus size={15} /> Add connection
        </Button>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      ) : !data || data.connections.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <Plug className="mx-auto mb-2 text-slate-400" size={22} />
          <p className="text-sm text-slate-600 dark:text-slate-300">No connections yet.</p>
          <p className="text-xs text-slate-500">Add NetSuite or QuickBooks Online to start a migration.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {data.connections.map((c) => (
            <div key={c.id} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-slate-800 dark:text-slate-100">{c.displayName}</span>
                  <Badge variant="secondary">{c.source}</Badge>
                  <Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>{c.status}</Badge>
                  {c.mirrorEnabled ? <Badge variant="success">mirror: {c.mirrorSchedule}</Badge> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" disabled={busy === `${c.id}:test`} onClick={() => test(c)}>
                    <FlaskConical size={14} /> Test
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy === `${c.id}:mirror`} onClick={() => run(c, 'mirror')}>
                    <RefreshCw size={14} /> Mirror now
                  </Button>
                  <Button size="sm" disabled={busy === `${c.id}:full_migration`} onClick={() => run(c, 'full_migration')}>
                    <Play size={14} /> Run migration
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggleMirror(c)}>
                    {c.mirrorEnabled ? 'Pause mirror' : 'Enable mirror'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDrawer({ editing: c })}>
                    <Pencil size={14} /> Edit
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy === `${c.id}:del`} onClick={() => remove(c)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Last run: {fmt(c.lastRunAt)} · Synced through: {fmt(c.cursor)}
                {c.lastError ? <span className="text-red-500"> · {c.lastError}</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent runs */}
      {data && data.runs.length > 0 ? (
        <div className="mt-8 space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Recent runs</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{fmt(r.startedAt)}</TableCell>
                  <TableCell>{r.kind}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === 'ok' ? 'success' : r.status === 'failed' ? 'destructive' : 'secondary'}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.triggeredBy ?? '—'}</TableCell>
                  <TableCell className="text-slate-500">
                    {r.status === 'ok' && r.stats
                      ? `+${r.stats.docsNew ?? 0} docs · ${r.stats.docsAmended ?? 0} amended · ${r.stats.docsUnchanged ?? 0} unchanged` +
                        `${(r.stats.applications?.inserted ?? 0) > 0 ? ` · ${r.stats.applications?.inserted} applied` : ''}` +
                        ` · TB ${r.stats.tb?.matches ?? 0}/${r.stats.tb?.accounts ?? 0}` +
                        `${(r.stats.tb?.mismatches?.length ?? 0) > 0 ? ` (${r.stats.tb?.mismatches?.length} off)` : ''}` +
                        `${r.stats.openItems ? ` · open items ${r.stats.openItems.matches}/${r.stats.openItems.checked}` : ''}`
                      : (r.errorMessage ?? '')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {data ? (
        <ConnectionDrawer
          open={drawer !== null}
          onClose={() => setDrawer(null)}
          sourceTypes={data.sourceTypes}
          currencies={data.currencies}
          editing={drawer?.editing}
          onSaved={() => { setDrawer(null); void load() }}
        />
      ) : null}
    </div>
  )
}

// --- Add-connection wizard (drawer) ------------------------------------------

function configOptions(f: FieldSpec, currencies: Currency[]): { value: string; label: string }[] {
  if (f.optionsSource === 'currencies') return currencies.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))
  return f.options ?? []
}

function ConnectionDrawer({
  open,
  onClose,
  sourceTypes,
  currencies,
  editing,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  sourceTypes: SourceTypeDef[]
  currencies: Currency[]
  /** When set, the drawer edits this connection instead of creating one. */
  editing?: Connection | null
  onSaved: () => void
}) {
  const [source, setSource] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Prefill from the edited connection (or clear for a fresh add) on open.
  useEffect(() => {
    if (!open) return
    if (editing) {
      setSource(editing.source)
      setDisplayName(editing.displayName)
      setConfig(Object.fromEntries(Object.entries(editing.config ?? {}).map(([k, v]) => [k, String(v ?? '')])))
      setSecrets({})
    } else {
      setSource(''); setDisplayName(''); setConfig({}); setSecrets({})
    }
  }, [open, editing])

  const def = sourceTypes.find((s) => s.source === source)

  async function save() {
    if (!def) return
    setSaving(true)
    try {
      const provided = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''))
      const res = editing
        ? await fetch(`/api/platform/connections/${editing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName, config, secrets: provided }),
          })
        : await fetch('/api/platform/connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source, displayName, config, secrets: provided }),
          })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(editing ? 'Connection updated' : 'Connection created')
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? 'Edit connection' : 'Add connection'}
      description="Connect an external accounting system. Credentials are encrypted at rest and never shown again."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {def ? (
            <Button disabled={saving} onClick={save}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create connection'}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>System</Label>
          {editing ? (
            <Input value={def?.displayName ?? editing.source} disabled />
          ) : (
            <Select value={source} onChange={(e) => { setSource(e.target.value); setConfig({}); setSecrets({}) }}>
              <option value="">Select a system…</option>
              {sourceTypes.map((s) => (
                <option key={s.source} value={s.source}>{s.displayName}</option>
              ))}
            </Select>
          )}
        </div>

        {def ? (
          <>
            {!editing ? <p className="text-xs text-slate-500">{def.blurb}</p> : null}
            <div>
              <Label>Connection name</Label>
              <Input value={displayName} placeholder={def.displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>

            {def.configFields.map((f) => (
              <div key={f.key}>
                <Label>{f.label}{f.required ? ' *' : ''}</Label>
                {f.kind === 'select' ? (
                  <Select
                    value={config[f.key] ?? ''}
                    onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {configOptions(f, currencies).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={config[f.key] ?? ''}
                    placeholder={f.placeholder}
                    onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                  />
                )}
                {f.help ? <p className="mt-1 text-xs text-slate-400">{f.help}</p> : null}
              </div>
            ))}

            {def.secretFields.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/40 dark:bg-amber-900/10">
                <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  Credentials (encrypted at rest, never displayed again)
                </p>
                <div className="space-y-3">
                  {def.secretFields.map((f) => (
                    <div key={f.key}>
                      <Label>{f.label}{f.required && !editing ? ' *' : ''}</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        placeholder={editing ? 'Leave blank to keep current' : undefined}
                        value={secrets[f.key] ?? ''}
                        onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Drawer>
  )
}
