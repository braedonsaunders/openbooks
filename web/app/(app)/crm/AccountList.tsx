import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, pickString } from '../../../lib/list-params'
import { loadParty } from '../../api/parties/_lib'
import { loadCrmAccount } from '../../../lib/crm'
import { CrmNewButton } from './CrmNewButton'
import { AccountDrawer } from './AccountDrawer'

export async function AccountList({
  stage,
  searchParams,
}: {
  stage: 'lead' | 'prospect'
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('crm.accounts.read')
  const canManage = can(authz, 'crm.accounts.manage')
  const canCreate = can(authz, 'crm.accounts.create')
  const t = await getTranslations('crm')
  const sp = await searchParams
  const basePath = stage === 'lead' ? '/crm/leads' : '/crm/prospects'
  const openId = pickString(sp.account)
  const newButton = canCreate ? (
    <CrmNewButton
      apiPath="/api/crm/accounts/draft"
      basePath={basePath}
      param="account"
      label={t(`accounts.${stage}.new`)}
      failed={t('feedback.createFailed')}
    />
  ) : undefined

  let drawer: React.ReactNode = null
  if (openId && isUuid(openId)) {
    const [party, account, statuses, owners, territories, sources] = await Promise.all([
      loadParty(openId, authz.user.orgId),
      loadCrmAccount(openId, authz.user.orgId),
      db.execute(sql`select id,name,lifecycle_stage from crm_account_statuses where org_id=${authz.user.orgId} and is_active order by lifecycle_stage,sequence`) as any,
      db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select id,name from crm_sales_territories where org_id=${authz.user.orgId} and is_active order by priority,name`) as any,
      db.execute(sql`select id,name from crm_lead_sources where org_id=${authz.user.orgId} and is_active order by name`) as any,
    ])
    if (party && account) {
      const requestedReturn = pickString(sp.drawerReturn)
      drawer = (
        <AccountDrawer
          data={{ ...party, crm: account }}
          statuses={statuses.rows}
          owners={owners.rows}
          territories={territories.rows}
          sources={sources.rows}
          basePath={requestedReturn?.startsWith(basePath) ? requestedReturn : basePath}
          canManage={canManage}
        />
      )
    }
  }

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t(`accounts.${stage}.title`)}
          description={t(`accounts.${stage}.description`)}
          actions={newButton}
        />
      }
    >
      <EntityListView
        recordType={stage}
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newButton}
      />
    </ListPageLayout>
  )
}
