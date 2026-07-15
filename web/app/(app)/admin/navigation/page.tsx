import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { currentUser } from '../../../../lib/auth'
import { defaultNavConfig, type OrgNavConfig } from '../../../../lib/nav/registry'
import { NavEditor } from './NavEditor'

export const dynamic = 'force-dynamic'

export default async function NavigationAdmin() {
  const user = await currentUser()
  if (!user) return null
  const t = await getTranslations('admin.navigation')

  const r = (await db.execute(
    sql`select config from org_nav_configs where org_id = ${user.orgId} limit 1`,
  )) as unknown as { rows: { config: OrgNavConfig }[] }
  const config = r.rows[0]?.config ?? defaultNavConfig()

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader title={t('title')} description={t('description')} />
      <div className="mt-6">
        <NavEditor initial={config} />
      </div>
    </PageContainer>
  )
}
