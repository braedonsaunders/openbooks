'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Textarea } from '@openbooks/ui'
import { promptDialog } from '@/lib/prompt'
import { enterOrg } from '@/lib/sandbox-session'
import type { AdminModuleDrawer } from './view'

type Change = { kind: string; identity: string; change: 'added' | 'changed' | 'removed'; target: string }
type Preview = { route: string; previewUrl: string | null; previewError?: string }
type Result = {
  error?: string; errors?: string[]; changes?: Change[]; previews?: Preview[];
  permissions?: { added: string[]; removed: string[] }; outcome?: string;
  staged?: boolean | object | null; applied?: boolean; gateIds?: string[];
}

/** The existing layout editor's shared form controls, composed inside UrlDrawer. */
export function ModuleActions({ drawer, sandboxes, canCustomize }: {
  drawer: AdminModuleDrawer | null
  sandboxes: { orgId: string; name: string }[]
  canCustomize: boolean
}) {
  const t = useTranslations('admin.modules.actions')
  const router = useRouter()
  const [manifest, setManifest] = useState(() => JSON.stringify(drawer?.manifest ?? { key: '', name: '', version: '1.0.0', permissions: [], contributions: [] }, null, 2))
  const [reason, setReason] = useState('')
  const [sandboxOrgId, setSandbox] = useState(sandboxes[0]?.orgId ?? '')
  const [result, setResult] = useState<Result | null>(null)
  const [diff, setDiff] = useState<Result | null>(null)
  const [previews, setPreviews] = useState<Preview[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: string, extra: Record<string, unknown> = {}) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const needsManifest = ['install', 'diff', 'stageRehearsal'].includes(action)
      const value: unknown = needsManifest ? JSON.parse(manifest) : undefined
      const key = drawer?.key ?? (JSON.parse(manifest) as { key?: string }).key
      const response = await fetch(action === 'publish' ? '/api/apps/marketplace' : '/api/admin/modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action === 'publish' ? 'publishModule' : action, key, moduleId: drawer?.id, manifest: value, sandboxOrgId, reason: reason.trim() || undefined, ...extra }),
      })
      const data = await response.json() as Result
      if (!response.ok || data.error || data.errors?.length) throw new Error(data.error ?? data.errors?.join('; ') ?? t('failed'))
      setResult(data)
      if (data.changes) setDiff(data)
      if (data.previews) setPreviews(data.previews)
      if (action === 'install' && !drawer && key) router.push(`/admin/modules?module=${encodeURIComponent(key)}`)
      else if (!['diff', 'describeRehearsal'].includes(action)) router.refresh()
    } catch (err) {
      setError(err instanceof SyntaxError ? t('invalidJson') : err instanceof Error ? err.message : t('failed'))
    } finally { setBusy(false) }
  }

  async function confirm(action: string, extra: Record<string, unknown> = {}) {
    const explanation = await promptDialog({ title: t(`${action}Confirm`), label: t('reason'), confirmLabel: t(action) })
    if (explanation) await run(action, { ...extra, reason: explanation })
  }

  async function sign(gateId: string) {
    const signature = await promptDialog({ title: t('applyConfirm'), label: t('signature'), confirmLabel: t('apply') })
    if (signature) await run('apply', { gateId, signature })
  }

  if (drawer?.kind === 'app') return <Button asChild variant="outline" size="sm"><Link href={`/admin/apps?app=${encodeURIComponent(drawer.key)}` as never}>{t('manageApp')}</Link></Button>

  return <section className="space-y-4">
    {drawer ? <div className="flex flex-wrap gap-2">
      {canCustomize && !drawer.noLiveVersion ? <Button size="sm" variant="outline" disabled={busy || drawer.pendingGates.length > 0} onClick={() => confirm(drawer.status === 'disabled' ? 'reactivate' : 'deactivate')}>{t(drawer.status === 'disabled' ? 'reactivate' : 'deactivate')}</Button> : null}
      {canCustomize && drawer.status !== 'disabled' && !drawer.noLiveVersion ? <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm('publish')}>{t('publish')}</Button> : null}
      {drawer.pendingGates.length > 0 ? <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm('cancelApproval')}>{t('cancelApproval')}</Button> : null}
      {canCustomize && drawer.status !== 'disabled' && drawer.versions.some(v => v.status === 'superseded') ? <Button size="sm" variant="outline" disabled={busy || drawer.pendingGates.length > 0} onClick={() => confirm('rollback')}>{t('rollback')}</Button> : null}
      {canCustomize ? drawer.pendingGates.filter(g => g.canApply).map(g => <Button key={g.gateId} size="sm" disabled={busy} onClick={() => sign(g.gateId)}>{t('apply')} {g.version}</Button>) : null}
    </div> : null}
    {canCustomize ? <>
      <div className="space-y-2"><Label htmlFor="module-manifest">{t('manifest')}</Label><Textarea id="module-manifest" rows={12} className="font-mono text-xs" value={manifest} onChange={e => { setManifest(e.target.value); setDiff(null); setPreviews([]); setResult(null) }} /></div>
      <div className="space-y-2"><Label htmlFor="module-reason">{t('reason')}</Label><Input id="module-reason" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></div>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => run('diff')}>{t('diff')}</Button><Button size="sm" disabled={busy || !reason.trim()} onClick={() => run('install')}>{t('install')}</Button></div>
      {sandboxes.length > 0 ? <div className="space-y-2">
        <Label htmlFor="module-sandbox">{t('sandbox')}</Label>
        <select id="module-sandbox" value={sandboxOrgId} onChange={e => { setSandbox(e.target.value); setDiff(null); setPreviews([]) }} className="h-10 w-full rounded-md border border-slate-200 bg-transparent px-3 text-sm dark:border-slate-800">
          {sandboxes.map(s => <option key={s.orgId} value={s.orgId}>{s.name}</option>)}
        </select>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !reason.trim()} onClick={() => run('stageRehearsal')}>{t('stageRehearsal')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run('describeRehearsal')}>{t('describeRehearsal')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm('discardRehearsal')}>{t('discardRehearsal')}</Button>
          <Button size="sm" disabled={busy} onClick={() => confirm('promoteRehearsal')}>{t('promoteRehearsal')}</Button>
        </div>
        <p className="text-xs text-slate-500">{t('previewHelp')}</p>
        {previews.map(p => <div key={p.route}>{p.previewUrl ? <Button variant="link" size="sm" onClick={() => enterOrg(sandboxOrgId, p.previewUrl!)}>{t('preview')} {p.route}</Button> : <p className="text-sm text-slate-500">{p.route}: {p.previewError}</p>}</div>)}
      </div> : null}
    </> : null}
    {diff?.changes ? <section className="rounded-md border border-slate-200 p-3 dark:border-slate-800" aria-label={t('diff')}>
      <h3 className="text-sm font-semibold">{t('diff')}</h3>
      {diff.changes.length ? <ul className="mt-2 space-y-1 text-sm">{diff.changes.map(c => <li key={`${c.kind}:${c.identity}`}><strong>{t(c.change)}</strong> · {c.kind} · <code>{c.identity}</code></li>)}</ul> : <p className="mt-2 text-sm">{t('unchanged')}</p>}
      {diff.permissions ? <p className="mt-2 text-xs">{t('permissionsAdded')}: {diff.permissions.added.join(', ') || '—'}<br />{t('permissionsRemoved')}: {diff.permissions.removed.join(', ') || '—'}</p> : null}
    </section> : null}
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    {result && !error ? <p role="status" className="text-sm text-teal-700">{result.staged === true || result.outcome === 'awaiting-approval' ? t('awaitingApproval') : t('done')}</p> : null}
  </section>
}
