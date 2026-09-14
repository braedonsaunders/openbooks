'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, UrlDrawer, cn } from '@openbooks/ui'
import { Download, Pencil } from 'lucide-react'
import { parseManifest, type AppManifest } from '@/lib/apps/manifest'
import {
  nextAppVersion,
  type EditableAppPackage,
} from '@/lib/apps/package-files'
import { confirmDialog } from '@/lib/confirm'
import { AppPackageEditor } from './AppPackageEditor'
import { AppHistory } from './AppHistory'

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
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? t('failed'))
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
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? t('failed'))
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
    >
      <div className="space-y-5">
        <div
          className="flex flex-wrap gap-2 border-b"
          role="tablist"
          aria-label={t('workspace')}
        >
          {(
            [
              'overview',
              ...(canAuthor ? (['package'] as const) : []),
              'versions',
              'runs',
              'storage',
              'audit',
            ] as const
          ).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => {
                if (value === 'package' && !editing) void edit()
                else setTab(value)
              }}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
                tab === value
                  ? 'border-teal-500 text-teal-700 dark:text-teal-300'
                  : 'border-transparent text-slate-500',
              )}
            >
              {t(value)}
            </button>
          ))}
        </div>
        {tab === 'overview' ? (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {app.description}
              </p>
              <Badge
                variant={app.status === 'installed' ? 'success' : 'outline'}
              >
                {t(app.status)}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
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
            </div>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t('contents')}</h3>
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
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t('permissions')}</h3>
              <p className="text-sm text-slate-500">{t('permissionsHelp')}</p>
              {app.grantedPermissions.length ? (
                <ul className="list-inside list-disc text-sm">
                  {app.grantedPermissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">{t('noPermissions')}</p>
              )}
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{t('configuration')}</h3>
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
            </section>
            <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-semibold">{t('lifecycle')}</h3>
              <p className="text-sm text-slate-500">{t('lifecycleHelp')}</p>
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
            </section>
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
