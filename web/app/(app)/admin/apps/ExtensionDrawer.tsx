'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardHeader, CardTitle, CardDescription, CardContent, UrlDrawer } from '@openbooks/ui'
import { Download, Pencil, ShieldCheck, Settings2, Power, Code2 } from 'lucide-react'
import { parseManifest, type AppManifest } from '@/lib/apps/manifest'
import {
  nextAppVersion,
  type EditableAppPackage,
} from '@/lib/apps/package-files'
import { readApiErrorMessage } from '@/lib/api-error'
import { confirmDialog } from '@/lib/confirm'
import { AppPackageEditor } from './AppPackageEditor'
import { AppHistory } from './AppHistory'
import { AppWorkspaceTabs } from './sections'
import { AppOverviewHero } from './AppOverviewHero'

export function ExtensionDrawer({
  app,
  files,
  isPublished,
  canAuthor,
  closeHref = '/admin/apps',
}: {
  app: {
    key: string
    name: string
    description: string | null
    status: 'installed' | 'disabled'
    version: string | null
    activeVersionId: string | null
    grantedPermissions: string[]
    manifest: AppManifest | null
  }
  files: { path: string; size: number }[]
  runs: {
    endpoint: string
    status: string
    error_message: string | null
    at: string
  }[]
  isPublished: boolean
  canAuthor: boolean
  closeHref?: string
}) {
  const router = useRouter()
  const t = useTranslations('apps.management')
  const te = useTranslations('apps.editor')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<
    'overview' | 'package' | 'versions' | 'runs' | 'audit' | 'storage'
  >('overview')
  const [editing, setEditing] = useState<EditableAppPackage | null>(null)
  const [dirty, setDirty] = useState(false)
  async function leave() {
    return (
      !dirty ||
      (await confirmDialog({ message: t('discardEdits'), tone: 'danger' }))
    )
  }
  async function request(url: string, method: string, body?: unknown) {
    if (!(await leave())) return false
    setBusy(true)
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      // Status first: a non-JSON 500/HTML refusal must toast the API
      // failure, never a SyntaxError from response.json().
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, t('failed')))
      router.refresh()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
      return false
    } finally {
      setBusy(false)
    }
  }
  async function edit(versionId?: string) {
    if (!(await leave())) return
    setBusy(true)
    try {
      const response = await fetch(
        `/api/apps/${encodeURIComponent(app.key)}/package${versionId ? `?versionId=${versionId}` : ''}`,
      )
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, t('failed')))
      const result = await response.json()
      const manifest = parseManifest(result.bundle.manifest).manifest
      if (!manifest) throw new Error(t('failed'))
      setEditing({
        ...result.bundle,
        manifest: {
          ...manifest,
          version: nextAppVersion(app.version ?? manifest.version),
        },
      })
      setDirty(false)
      setTab('package')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={app.name}
      description={`${app.key} · ${app.version ?? ''}`}
      beforeClose={leave}
      subtabs={<AppWorkspaceTabs label={t('workspace')} selected={tab}
          tabs={(['overview', ...(canAuthor ? ['package' as const] : []), 'versions', 'runs', 'storage', 'audit'] as const).map(key => ({ key, label: t(key) }))}
          onSelect={value => { if (value === 'package' && !editing) void edit(); else setTab(value) }} />}
    >
      <div className="space-y-5">
        {tab === 'overview' ? (
          <div className="space-y-5">
            <AppOverviewHero
              name={app.name}
              description={app.description}
              version={app.version}
              renderer={app.manifest ? app.manifest.frontend.renderer ?? 'sandbox' : undefined}
              status={<Badge variant={app.status === 'installed' ? 'success' : 'outline'}>{t(app.status)}</Badge>}
              stats={[
                { label: te('files'), value: files.length },
                { label: te('endpoints'), value: app.manifest?.endpoints.length ?? 0 },
                { label: t('permissions'), value: app.grantedPermissions.length },
              ]}
              actions={<>
              {app.status === 'installed' ? (
                <Button asChild>
                  <Link href={`/apps/${app.key}`}>{t('open')}</Link>
                </Button>
              ) : null}
              {canAuthor ? (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => edit()}
                  >
                    <Pencil size={16} />
                    {t('editPackage')}
                  </Button>
                  <Button asChild variant="outline">
                    <a
                      href={`/api/apps/${encodeURIComponent(app.key)}/package?download=1`}
                    >
                      <Download size={16} />
                      {t('download')}
                    </a>
                  </Button>
                  <Button asChild variant="outline">
                    <Link
                      href={`/assistant?q=${encodeURIComponent(`Read app ${app.key} with get_app_package. Ask what I want changed and prepare an unpublished revision with draft_app. Do not activate it.`)}`}
                    >
                      {t('assistant')}
                    </Link>
                  </Button>
                </>
              ) : null}
            </>}
            />
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><Code2 size={18} aria-hidden />{t('contents')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
              <p className="text-sm">
                {t('summary', {
                  files: files.length,
                  actions: app.manifest?.endpoints.length ?? 0,
                  definitions: app.manifest?.contributions?.length ?? 0,
                })}
              </p>
              <ul className="list-inside list-disc text-sm">
                {app.manifest?.endpoints.map((endpoint) => (
                  <li key={endpoint.name}>
                    {endpoint.name} · {endpoint.method} · {endpoint.file}
                  </li>
                ))}
              </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck size={18} aria-hidden />{t('permissions')}</CardTitle>
                <CardDescription>{t('permissionsHelp')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
              {app.grantedPermissions.length ? (
                <ul className="list-inside list-disc text-sm">
                  {app.grantedPermissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">{t('noPermissions')}</p>
              )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><Settings2 size={18} aria-hidden />{t('configuration')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link href="/admin/navigation">{t('navigation')}</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/admin/setup/extension-settings">
                    {t('settings')}
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/admin/roles">{t('roles')}</Link>
                </Button>
              </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><Power size={18} aria-hidden />{t('lifecycle')}</CardTitle>
                <CardDescription>{t('lifecycleHelp')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {app.status === 'installed' ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmDialog(t('publishConfirm')))
                        await request('/api/apps/marketplace', 'POST', {
                          action: 'publish',
                          key: app.key,
                        })
                    }}
                  >
                    {t(isPublished ? 'updateListing' : 'publish')}
                  </Button>
                ) : null}
                {isPublished ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmDialog(t('unpublishConfirm')))
                        await request('/api/apps/marketplace', 'POST', {
                          action: 'unpublish',
                          key: app.key,
                        })
                    }}
                  >
                    {t('unpublish')}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirmDialog(
                        t(
                          app.status === 'installed'
                            ? 'disableConfirm'
                            : 'enableConfirm',
                        ),
                      )
                    )
                      await request(
                        `/api/apps/${encodeURIComponent(app.key)}`,
                        'PATCH',
                        {
                          status:
                            app.status === 'installed'
                              ? 'disabled'
                              : 'installed',
                        },
                      )
                  }}
                >
                  {t(app.status === 'installed' ? 'disable' : 'enable')}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      (await confirmDialog({
                        title: t('uninstall'),
                        message: t('uninstallConfirm'),
                        tone: 'danger',
                      })) &&
                      (await request(
                        `/api/apps/${encodeURIComponent(app.key)}`,
                        'DELETE',
                      ))
                    )
                      router.push(closeHref)
                  }}
                >
                  {t('uninstall')}
                </Button>
              </div>
              </CardContent>
            </Card>
          </div>
        ) : tab === 'package' ? (
          !editing ? (
            <p role="status">{t('loading')}</p>
          ) : null
        ) : (
          <AppHistory
            key={tab}
            appKey={app.key}
            section={tab}
            canAuthor={canAuthor}
            onRevision={edit}
          />
        )}
        {editing ? (
          <div hidden={tab !== 'package'}>
            <AppPackageEditor
              key={JSON.stringify(editing.manifest)}
              bundle={editing}
              baseVersionId={app.activeVersionId}
              initialTab="files"
              onDirtyChange={setDirty}
            />
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  )
}
