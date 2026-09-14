'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, UrlDrawer } from '@openbooks/ui'
import type { AppManifest } from '@/lib/apps/manifest'

export function ExtensionDrawer({ app, files, runs, isPublished, closeHref = '/admin/extensions' }: {
  app: { key: string; name: string; description: string | null; status: 'installed' | 'disabled'; version: string | null; grantedPermissions: string[]; manifest: AppManifest | null };
  files: { path: string; size: number }[];
  runs: { endpoint: string; status: string; error_message: string | null; at: string }[];
  isPublished: boolean;
  closeHref?: string;
}) {
  const router = useRouter()
  const t = useTranslations('apps.drawer')
  const tExtension = useTranslations('admin.extensions')
  const [busy, setBusy] = useState(false)
  async function setStatus() {
    setBusy(true)
    try {
      const response = await fetch(`/api/extensions/${encodeURIComponent(app.key)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: app.status === 'installed' ? 'disabled' : 'installed' }) })
      if (!response.ok) throw new Error(t('errors.updateFailed'))
      router.refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : t('errors.updateFailed')) }
    finally { setBusy(false) }
  }
  async function publish() {
    setBusy(true)
    try {
      const response = await fetch('/api/extensions/marketplace', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'publish',key:app.key})})
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? t('errors.updateFailed'))
      router.refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : t('errors.updateFailed')) }
    finally { setBusy(false) }
  }
  return <UrlDrawer open closeHref={closeHref} size="xl" title={app.name} description={app.version ?? ''}>
    <div className="space-y-5">
      <p>{app.description}</p><Badge variant={app.status === 'installed' ? 'success' : 'outline'}>{app.status}</Badge>
      <div className="flex flex-wrap gap-2">
        {app.status === 'installed' ? <Button asChild><Link href={`/apps/${app.key}`}>{t('actions.open')}</Link></Button> : null}
        <Button asChild variant="outline"><Link href={`/assistant?q=${encodeURIComponent(`Read extension ${app.key} with get_extension_package. Ask what I want changed and prepare an unpublished revision with draft_extension. Do not activate it.`)}`}>{tExtension('draft.revise')}</Link></Button>
        {app.status === 'installed' ? <Button variant="outline" disabled={busy} onClick={publish}>{tExtension(isPublished ? 'actions.updateListing' : 'actions.publish')}</Button> : null}
        <Button variant="outline" disabled={busy} onClick={setStatus}>{app.status === 'installed' ? tExtension('actions.deactivate') : tExtension('actions.reactivate')}</Button>
      </div>
      <h3 className="font-semibold">{tExtension('draft.permissions')}</h3><ul className="list-inside list-disc text-sm">{app.grantedPermissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
      <details><summary>{tExtension('actions.advanced')}</summary><pre className="overflow-auto text-xs">{JSON.stringify(app.manifest, null, 2)}</pre><ul>{files.map(file => <li key={file.path}>{file.path}</li>)}</ul></details>
      {runs.length > 0 && <details><summary>{t('tabs.runs')}</summary><ul className="space-y-2 text-sm">{runs.map((run,index) => <li key={index}>{run.at} · {run.endpoint} · {run.status}{run.error_message ? ` — ${run.error_message}` : ''}</li>)}</ul></details>}
    </div>
  </UrlDrawer>
}
