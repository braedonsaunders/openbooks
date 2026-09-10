import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { currentUser } from '../../../../lib/auth'
import { listApps } from '../../../../lib/apps/store'
import { defaultNavConfig, type OrgNavConfig } from '../../../../lib/nav/registry'
import { NavEditor } from './NavEditor'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadNavigationAdmin, navigationAdminSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function NavigationAdmin({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadNavigationAdmin(sp)
    if (!data) return null
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={navigationAdminSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const user = await currentUser()
  if (!user) return null
  const t = await getTranslations('admin.navigation')
  const tHub = await getTranslations('admin.hub')

  const [r, apps] = await Promise.all([
    db.execute<{ config: OrgNavConfig }>(sql`select config from org_nav_configs where org_id = ${user.orgId} limit 1`),
    listApps(user.orgId),
  ])
  const saved = r.rows[0]?.config
  const navApps = apps
    .filter((app) => app.status === 'installed' && app.activeVersionId)
    .map((app) => ({
      key: app.key,
      name: app.manifest?.nav?.label?.trim() || app.name,
      iconKey: app.manifest?.nav?.icon?.trim() || app.iconKey,
    }))
  const config = saved?.version === 2 ? saved : defaultNavConfig()

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader back={{ href: '/admin', label: tHub('title') }} title={t('title')} description={t('description')} />
      <div className="mt-6">
        <NavEditor initial={config} apps={navApps} />
      </div>
    </PageContainer>
  )
}
