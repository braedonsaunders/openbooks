import { sql } from 'drizzle-orm'
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

  const r = (await db.execute(
    sql`select config from org_nav_configs where org_id = ${user.orgId} limit 1`,
  )) as unknown as { rows: { config: OrgNavConfig }[] }
  const config = r.rows[0]?.config ?? defaultNavConfig()

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Navigation"
        description="Customize the sidebar for everyone in the organization: rename, reorder, hide modules, or add links. Permission gates still apply on top."
      />
      <div className="mt-6">
        <NavEditor initial={config} />
      </div>
    </PageContainer>
  )
}
