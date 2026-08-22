import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { EntityListView } from '../../../../components/entity-list-view'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadActivity } from '../../../../lib/crm'
import { CrmNewButton } from '../CrmNewButton'
import { ActivityDrawer } from '../ActivityDrawer'

export const dynamic = 'force-dynamic'

export default async function Activities({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('crm.activities.read')
  const manage = can(authz, 'crm.activities.manage')
  const t = await getTranslations('crm')
  const sp = await searchParams
  const openId = pickString(sp.activity)
  const button = manage ? (
    <CrmNewButton
      apiPath="/api/crm/activities/draft"
      basePath="/crm/activities"
      param="activity"
      label={t('activities.new')}
      failed={t('feedback.createFailed')}
    />
  ) : undefined

  let drawer: React.ReactNode = null
  if (openId && isUuid(openId)) {
    const [open, owners, accounts, opportunities] = await Promise.all([
      loadActivity(openId, authz.user.orgId),
      db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select p.id,p.display_name name from crm_account_profiles cp join parties p on p.id=cp.party_id and p.org_id=cp.org_id where cp.org_id=${authz.user.orgId} and cp.is_active order by p.display_name limit 2000`) as any,
      db.execute(sql`select id,opportunity_number,title from crm_opportunities where org_id=${authz.user.orgId} and is_active order by created_at desc limit 2000`) as any,
    ])
    if (open) {
      const requestedReturn = pickString(sp.drawerReturn)
      drawer = (
        <ActivityDrawer
          data={open}
          owners={owners.rows}
          accounts={accounts.rows}
          opportunities={opportunities.rows}
          closeHref={requestedReturn?.startsWith('/crm/activities') ? requestedReturn : '/crm/activities'}
          canManage={manage}
        />
      )
    }
  }

  return (
    <ListPageLayout
      header={<PageHeader title={t('activities.title')} description={t('activities.description')} actions={button} />}
    >
      <EntityListView
        recordType="activity"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={button}
      />
    </ListPageLayout>
  )
}
