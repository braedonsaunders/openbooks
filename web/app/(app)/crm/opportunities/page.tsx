import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { EntityListView } from '../../../../components/entity-list-view'
import { ListPageLayout } from '../../../../components/page-layout'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadOpportunity } from '../../../../lib/crm'
import { CrmNewButton } from '../CrmNewButton'
import { OpportunityDrawer } from '../OpportunityDrawer'

export const dynamic = 'force-dynamic'

/**
 * Opportunities use the universal entity-list renderer. This page owns only
 * the title/create action and the opportunity-specific editor payload.
 */
export default async function Opportunities({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('crm.opportunities.read')
  const manage = can(authz, 'crm.opportunities.manage')
  const canCustomize = can(authz, 'admin.customization.manage')
  const t = await getTranslations('crm')
  const sp = await searchParams
  const openId = pickString(sp.opportunity)

  const button = manage ? (
    <CrmNewButton
      apiPath="/api/crm/opportunities/draft"
      basePath="/crm/opportunities"
      param="opportunity"
      label={t('opportunities.new')}
      failed={t('feedback.createFailed')}
    />
  ) : undefined

  let drawer: React.ReactNode = null
  if (openId && isUuid(openId)) {
    const [open, statuses, owners, accounts, contacts, teams, sources, items, currencies] = await Promise.all([
      loadOpportunity(openId, authz.user.orgId),
      db.execute(sql`select * from crm_opportunity_statuses where org_id=${authz.user.orgId} and is_active order by sequence`) as any,
      db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select p.id,p.display_name name from crm_account_profiles cp join parties p on p.id=cp.party_id where cp.org_id=${authz.user.orgId} and cp.is_active order by p.display_name limit 2000`) as any,
      db.execute(sql`select id,party_id,name from contacts where org_id=${authz.user.orgId} and is_active order by name limit 4000`) as any,
      db.execute(sql`select id,name from crm_sales_teams where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select id,name from crm_lead_sources where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select id,concat_ws(' · ',code,name) name from items where org_id=${authz.user.orgId} and is_active order by name limit 2000`) as any,
      db.execute(sql`select code,name from currencies order by code`) as any,
    ])
    const requestedReturn = pickString(sp.drawerReturn)
    const closeHref = requestedReturn?.startsWith('/crm/opportunities')
      ? requestedReturn
      : '/crm/opportunities'
    if (open) {
      drawer = (
        <OpportunityDrawer
          data={open}
          statuses={statuses.rows}
          owners={owners.rows}
          accounts={accounts.rows}
          contacts={contacts.rows}
          teams={teams.rows}
          sources={sources.rows}
          items={items.rows}
          currencies={currencies.rows}
          closeHref={closeHref}
          canManage={manage}
        />
      )
    }
  }

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('opportunities.title')}
          description={t('opportunities.description')}
          actions={button}
        />
      }
    >
      <EntityListView
        recordType="opportunity"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={canCustomize}
        sp={sp}
        drawer={drawer}
        emptyAction={button}
      />
    </ListPageLayout>
  )
}
