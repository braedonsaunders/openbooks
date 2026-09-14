import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Alert, AlertDescription } from '@openbooks/ui'
import { ModuleHomeTabs } from '@/components/module-home/ui'
import { DraftRecordPreview } from './DraftRecordPreview'
import { lintRecordFields } from '@/lib/record-schema'
import type { ParsedObjects } from '@/lib/apps/objects'
import type { NativeExtension as NativeUI } from '@/lib/apps/native-ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { PageHeader } from '@openbooks/ui'
import { getAppByKey } from '@/lib/apps/store'
import { parseNativeExtension } from '@/lib/apps/native-ui'
import { BlockList } from '@/components/viewspec/blocks'
import { ListPageLayout, DetailPageLayout } from '@/components/page-layout'
import { loadRecordWorkspace, recordModuleSpec } from '../../records/[typeKey]/view'

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
  `)).rows[0]
  if (!entry) notFound()
  const ui = parseNativeExtension(entry.content)
  const selected = typeof searchParams.screen === 'string' ? searchParams.screen : ui.screens[0]!.key
  const screen = ui.screens.find(item => item.key === selected)
  if (!screen) notFound()
  return <NativeScreens ui={ui} appKey={appKey} name={app.name} description={app.description} grants={app.grantedPermissions} searchParams={searchParams} />
}

export async function NativeScreens({ ui, appKey, name, description, grants, searchParams, preview }: {
  ui: NativeUI; appKey: string; name: string; description: string | null; grants: string[];
  searchParams: Record<string, string | string[] | undefined>;
  preview?: { id: string; objects: ParsedObjects }
}) {
  const authz = await requirePermission(preview ? 'apps.manage' : 'apps.use')
  const selected = typeof searchParams.screen === 'string' ? searchParams.screen : ui.screens[0]!.key
  const screen = ui.screens.find(item => item.key === selected)
  if (!screen) notFound()
  const t = await getTranslations('admin.modules.native')
  const tabs = <ModuleHomeTabs tabs={ui.screens.map(item => ({ href: `${preview ? '/admin/modules/preview/' + preview.id : '/apps/' + appKey}?screen=${encodeURIComponent(item.key)}`, label: item.title, active: item.key === selected }))} />
  if (screen.kind === 'records') {
    if (preview) {
      const type = preview.objects.recordTypes.find(item => item.key === screen.typeKey)
      const fields = type ? lintRecordFields(type.fields, type.name) : null
      return <ListPageLayout header={<>{tabs}<PageHeader title={screen.title} /></>}>
        <Alert variant="info"><AlertDescription>{t('previewRecords')}</AlertDescription></Alert>
        {fields?.success ? <DraftRecordPreview sections={fields.sections} /> : <p>{t('existingRecordsPreview')}</p>}
      </ListPageLayout>
    }
    if (!grants.includes('records.read') || !can(authz, 'records.read')) notFound()
    const data = await loadRecordWorkspace(searchParams, screen.typeKey, `/apps/${appKey}`)
    // A native extension cannot offer a write its package was not granted.
    data.canCreate = data.canCreate && grants.includes('records.create')
    if (data.drawerProps) data.drawerProps.canEdit = data.drawerProps.canEdit && grants.includes('records.create')
    const spec = recordModuleSpec(data)
    return <ListPageLayout header={<>{tabs}<BlockList blocks={spec.header} scope={data} searchParams={searchParams} /></>}><BlockList blocks={spec.body} scope={data} searchParams={searchParams} /></ListPageLayout>
  }
  const scope = { name, description, key: appKey }
  const header = <>{tabs}<BlockList blocks={screen.spec.header} scope={scope} searchParams={searchParams} /></>
  const body = <BlockList blocks={screen.spec.body} scope={scope} searchParams={searchParams} />
  if (screen.spec.layout === 'bare') return <>{header}{body}</>
  const Layout = screen.spec.layout === 'detail' ? DetailPageLayout : ListPageLayout
  return <Layout header={header} className={screen.spec.bodyClassName}>{body}</Layout>
}
