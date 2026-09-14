'use client'
import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Button, UrlDrawer } from '@openbooks/ui'
import type { ExtensionDraft } from '@/lib/application/extensions'
import { parseManifest } from '@/lib/apps/manifest'
import { parseObjectSpecs } from '@/lib/apps/objects'

export function ExtensionReview({ draft }: { draft: ExtensionDraft }) {
  const t = useTranslations('admin.modules.draft')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const manifest = parseManifest(draft.bundle.manifest).manifest!
  const objects = parseObjectSpecs(draft.bundle.files)
  async function activate(action: 'activate' | 'discard') {
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/extensions/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, draftId: draft.id, contentHash: draft.content_hash }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? t('failed'))
      router.push(data.reviewUrl ?? '/admin/modules'); router.refresh()
    } catch (e) { setError(e instanceof Error ? e.message : t('failed')) }
    finally { setBusy(false) }
  }
  return <UrlDrawer open closeHref="/admin/modules" size="xl" title={manifest.name} description={`${t('title')} · ${manifest.version}`}>
    <div className="space-y-5">
      <p>{draft.reason}</p>
      <Alert variant="info"><AlertDescription>{t('unpublished')}</AlertDescription></Alert>
      <div className="flex gap-2"><Button asChild variant="outline"><Link href={`/admin/modules/preview/${draft.id}` as never} target="_blank">{t('preview')}</Link></Button><Button asChild variant="outline"><Link href={`/assistant?q=${encodeURIComponent(`Revise extension draft ${draft.id}. Read it with get_extension_draft, ask what I want changed, and prepare a new draft for review. Do not activate it.`)}` as never}>{t('revise')}</Link></Button></div>
      <section className="space-y-2"><h3 className="font-semibold">{t('changes')}</h3>
        {draft.changes.newPackage ? <p>{t('newPackage')}</p> : null}
        {(['added', 'changed', 'removed'] as const).map(kind => draft.changes[kind].length ? <p key={kind} className="break-all text-sm"><strong>{t(kind)}: </strong>{draft.changes[kind].join(', ')}</p> : null)}
        <p className="text-sm text-slate-500">{t('retainedData')}</p>
      </section>
      <section><h3 className="font-semibold">{t('contents')}</h3><ul className="list-inside list-disc text-sm">{objects.recordTypes.map(type => <li key={type.key}>{t('recordType', { name: type.name })}</li>)}{objects.customFields.map(field => <li key={`${field.targetTable}:${field.key}`}>{t('field', { name: field.label })}</li>)}{manifest.endpoints.map(endpoint => <li key={endpoint.name}>{t('action', { name: endpoint.name })}</li>)}<li>{t('files', { count: draft.bundle.files.length })}</li></ul></section>
      <section><h3 className="font-semibold">{t('permissions')}</h3>{manifest.permissions.length ? <ul className="list-inside list-disc text-sm">{manifest.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul> : <p className="text-sm">{t('noPermissions')}</p>}</section>
      <details><summary className="cursor-pointer text-sm">{t('source')}</summary><pre className="max-h-72 overflow-auto text-xs">{JSON.stringify(draft.bundle, null, 2)}</pre><code className="break-all text-xs">{draft.content_hash}</code></details>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {draft.status === 'draft' ? <><label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{t('confirm')}</label><Button disabled={busy || !reviewed} onClick={() => activate('activate')}>{t('activate')}</Button><Button variant="outline" disabled={busy} onClick={() => activate('discard')}>{t('discard')}</Button></> : <p>{t('closed')}</p>}
    </div>
  </UrlDrawer>
}
