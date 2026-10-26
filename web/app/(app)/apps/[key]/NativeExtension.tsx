import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Alert, AlertDescription } from '@openbooks/ui'
import { ModuleHomeTabs } from '@/components/module-home/ui'
import { NativeActionForm } from './NativeActionForm'
import { DraftRecordPreview } from './DraftRecordPreview'
import { lintRecordFields } from '@/lib/record-schema'
import type { ParsedObjects } from '@/lib/apps/objects'
import type { NativeExtension as NativeUI } from '@/lib/apps/native-ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { can, requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { PageHeader, PageHeaderNavigationProvider } from '@openbooks/ui'
import { getAppByKey, invokeAppEndpointHandler } from '@/lib/apps/store'
import { randomUUID } from 'node:crypto'
import { parseNativeExtension } from '@/lib/apps/native-ui'
import { BlockList } from '@/components/viewspec/blocks'
import { ListPageLayout, DetailPageLayout } from '@/components/page-layout'
import { loadRecordWorkspace, recordModuleSpec } from '../../records/[typeKey]/view'
import { readNavigationConfig } from '@/lib/nav/config'
import { applyLocalNavigationPreferences } from '@openbooks/engine/navigation'

/** Installed bytes and grants come from one version-pinned package lookup. */
export async function NativeExtension({ appKey, searchParams }: {
  appKey: string
  searchParams: Record<string, string | string[] | undefined>
}) {
  const authz = await requirePermission('apps.use')
  await requireFeatureEnabled(authz.user.orgId, 'apps')
  const app = await getAppByKey(authz.user.orgId, appKey)
  if (!app || app.status !== 'installed' || !app.activeVersionId || app.manifest?.frontend.renderer !== 'native') notFound()
  const entry = (await db.execute<{ content: string }>(sql`
    select content from app_files where org_id=${authz.user.orgId} and app_id=${app.id}
      and version_id=${app.activeVersionId} and path=${app.manifest.frontend.entry} and not is_binary
  `, 'objects'))[0]
  if (!entry) notFound()
  const ui = parseNativeExtension(entry.content)
  const selected = typeof searchParams.screen === 'string' ? searchParams.screen : ui.screens[0]!.key
  const screen = ui.screens.find(item => item.key === selected)
  if (!screen) notFound()
  return <NativeScreens ui={ui} appKey={appKey} name={app.name} description={app.description} versionId={app.activeVersionId} grants={app.grantedPermissions} searchParams={searchParams} />
}

export async function NativeScreens({ ui, appKey, name, description, grants, searchParams, preview, versionId }: {
  ui: NativeUI; appKey: string; name: string; description: string | null; grants: string[];
  searchParams: Record<string, string | string[] | undefined>;
  versionId?: string;
  preview?: { id: string; objects: ParsedObjects }
}) {
  const authz = await requirePermission(preview ? 'apps.manage' : 'apps.use')
  const selected = typeof searchParams.screen === 'string' ? searchParams.screen : ui.screens[0]!.key
  const screen = ui.screens.find(item => item.key === selected)
  if (!screen) notFound()
  const t = await getTranslations('admin.extensions.native')
  const td = await getTranslations('admin.extensions.draft')
  const notice = preview ? <Alert variant="info"><AlertDescription>{td('previewNotice')}</AlertDescription></Alert> : null
  const preferences = preview ? undefined : (await readNavigationConfig(authz.user.orgId))?.config.localNavigation?.[`app:${appKey}`]
  const choices = ui.screens.filter(item => preview || item.kind !== 'records' || (grants.includes('records.read') && can(authz, 'records.read')))
    .map(item => ({ href: `${preview ? '/admin/apps/preview/' + preview.id : '/apps/' + appKey}?screen=${encodeURIComponent(item.key)}`, label: item.title, active: item.key === selected }))
  const tabs = <ModuleHomeTabs tabs={applyLocalNavigationPreferences(choices, preferences)} />
  if (screen.kind === 'action') return <DetailPageLayout header={<>{notice}<PageHeader title={screen.title} description={screen.description} actions={tabs} /></>}>
    <NativeActionForm key={`${versionId ?? preview?.id}:${screen.key}`} appKey={appKey} versionId={versionId} screen={screen} preview={!!preview} />
  </DetailPageLayout>
  if (screen.kind === 'records') {
    if (preview) {
      const type = preview.objects.recordTypes.find(item => item.key === screen.typeKey)
      const fields = type ? lintRecordFields(type.fields, type.name) : null
      if (fields?.success) return <DraftRecordPreview sections={fields.sections} typeKey={screen.typeKey} typeName={type!.name}
        title={screen.title} basePath={`/admin/apps/preview/${preview.id}`} searchParams={{ ...searchParams, screen: selected }} header={notice} headerNavigation={tabs} />
      return <ListPageLayout header={<>{notice}<PageHeader title={screen.title} actions={tabs} /></>}><p>{t('existingRecordsPreview')}</p></ListPageLayout>
    }
    if (!grants.includes('records.read') || !can(authz, 'records.read')) notFound()
    const data = await loadRecordWorkspace(searchParams, screen.typeKey, `/apps/${appKey}`)
    // A native extension cannot offer a write its package was not granted.
    data.canCreate = data.canCreate && grants.includes('records.create')
    if (data.drawerProps) data.drawerProps.canEdit = data.drawerProps.canEdit && grants.includes('records.create')
    const spec = recordModuleSpec(data)
    return <ListPageLayout header={<PageHeaderNavigationProvider navigation={tabs}><BlockList blocks={spec.header} scope={data} searchParams={searchParams} /></PageHeaderNavigationProvider>}><BlockList blocks={spec.body} scope={data} searchParams={searchParams} /></ListPageLayout>
  }
  // A page screen binds the app's identity and, when it declares a data
  // endpoint, that endpoint's body as `data`. The endpoint runs read-only as
  // the viewer; a refusal is shown, never rendered as empty figures.
  const loaded = screen.data && !preview
    ? await loadScreenData({ appKey, screenKey: screen.key, endpoint: screen.data.endpoint, authz, searchParams })
    : null
  const scope = { name, description, key: appKey, app: { name, description, key: appKey }, data: loaded?.ok ? loaded.data : null }
  const alerts = <>
    {notice}
    {screen.data && preview ? <Alert variant="info"><AlertDescription>{t('screenDataPreview')}</AlertDescription></Alert> : null}
    {loaded && !loaded.ok ? <Alert variant="destructive"><AlertDescription>{t('screenDataFailed', { error: loaded.error })}</AlertDescription></Alert> : null}
  </>
  // Every screen wears the house page shell: an authored header when the spec
  // has one, otherwise the screen's own title, with the app's screen tabs.
  const header = screen.spec.header.length
    ? <PageHeaderNavigationProvider navigation={tabs}><BlockList blocks={screen.spec.header} scope={scope} searchParams={searchParams} /></PageHeaderNavigationProvider>
    : <PageHeader title={screen.title} description={screen.description} actions={tabs} />
  const body = loaded && !loaded.ok
    ? null
    : <div className="space-y-6"><BlockList blocks={screen.spec.body} scope={scope} searchParams={searchParams} /></div>
  if (screen.spec.layout === 'list') {
    return <ListPageLayout header={<>{alerts}{header}</>} className={screen.spec.bodyClassName}>{body}</ListPageLayout>
  }
  return <DetailPageLayout header={header} alerts={alerts} className={screen.spec.bodyClassName}>{body}</DetailPageLayout>
}

async function loadScreenData(opts: {
  appKey: string; screenKey: string; endpoint: string
  authz: Awaited<ReturnType<typeof requirePermission>>
  searchParams: Record<string, string | string[] | undefined>
}): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const query = Object.fromEntries(Object.entries(opts.searchParams).flatMap(([name, value]) => typeof value === 'string' && name !== 'screen' ? [[name, value]] : []))
  const result = await invokeAppEndpointHandler({
    orgId: opts.authz.user.orgId,
    user: opts.authz.user,
    key: opts.appKey,
    endpoint: opts.endpoint,
    body: { screen: opts.screenKey, query },
    userCan: (permission) => can(opts.authz, permission),
    allowedSubsidiaryIds: opts.authz.allowedSubsidiaryIds,
    operation: `apps.screen_data.${opts.endpoint}`,
    auditEndpoint: opts.endpoint,
    readOnlyTool: true,
    idempotencyKey: `screen:${randomUUID()}`,
  })
  if (!result.ok) return { ok: false, error: result.error }
  const response = result.result as { status?: number; body?: unknown } | null
  if (response && typeof response.status === 'number' && response.status >= 400) {
    return { ok: false, error: typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? null) }
  }
  return { ok: true, data: response && 'body' in response ? response.body : response }
}
