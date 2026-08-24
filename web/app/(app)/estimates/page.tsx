import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { RecordListView } from '../../../components/record-list-view'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { loadOrder } from '../../api/_order/lib'
import { OrderDrawer } from '../_order/OrderDrawer'
import { NewOrderButton } from '../_order/NewOrderButton'
import { NewOrderRedirect } from '../_order/NewOrderRedirect'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'
import { taxCodeOptions, taxGroupOptions } from '../../../lib/documents'
import { subsidiaryUiOptions } from '../../../lib/subsidiaries'

export const dynamic = 'force-dynamic'

const KIND = 'quote' as const
const BASE = '/estimates'
const PARAM = 'estimate'
const API = '/api/estimates'
type OrderDrawerProps = Parameters<typeof OrderDrawer>[0]
type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

/**
 * Estimates (quotes). The list is the universal RecordListView; this page owns
 * the header, the New button, and the OrderDrawer flyout. Quote→order/invoice
 * conversion is reported in /reports/conversion, not on the list.
 */
export default async function Estimates({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ar.read')
  await requireFeatureEnabled(authz.user.orgId, 'orders')
  const inventoryEnabled = await isFeatureEnabled(authz.user.orgId, 'inventory')
  const canManage = can(authz, 'ar.create')
  const t = await getTranslations('estimates')
  const sp = await searchParams
  const openId = pickString(sp[PARAM])

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND) : null,
    openId && openId !== 'new'
      ? Promise.all([
          db.execute<ElementOf<OrderDrawerProps['parties']>>(sql`
            select p.id, p.display_name from parties p
             where p.org_id = ${authz.user.orgId} and p.is_active
               and exists (
                 select 1 from customer_roles cr
                  where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active
               )
             order by p.display_name limit 2000`),
          db.execute<ElementOf<OrderDrawerProps['accounts']>>(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and type in ('income','income_other') and is_active and not is_summary order by number nulls last`),
          db.execute<ElementOf<OrderDrawerProps['items']>>(sql`
            select id, code, name, default_rate, income_account_id, expense_account_id, tax_code_id, unit
              from items
             where org_id = ${authz.user.orgId} and is_active
               and (
                 ${inventoryEnabled ? sql`true` : sql`kind not in ('inventory', 'assembly', 'kit')`}
                 or id in (
                   select item_id from document_lines
                    where org_id = ${authz.user.orgId} and document_id = ${openId} and item_id is not null
                 )
               )
             order by name limit 2000`),
          taxCodeOptions(authz.user.orgId),
          taxGroupOptions(authz.user.orgId),
          db.execute<ElementOf<OrderDrawerProps['departments']>>(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`),
          db.execute<ElementOf<OrderDrawerProps['projects']>>(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`),
          customSegmentOptions(authz.user.orgId),
          subsidiaryUiOptions(authz.user.orgId),
        ])
      : null,
  ])
  const resolvedForm = openOrder && pickers ? await resolveFormLayout({
    orgId: authz.user.orgId, userId: authz.user.id, recordType: KIND,
    userRoles: authz.user.roles.map(({ key }) => key), headerDefs: [], lineDefs: [], explicitLayoutId: pickString(sp.form),
  }) : null
  const drawerOrder = openOrder as unknown as OrderDrawerProps['order'] | null

  const newBtn = canManage ? (
    <NewOrderButton apiPath={API} base={BASE} param={PARAM} label={t('list.newButton')} createFailedMessage={t('list.createDraftFailed')} />
  ) : undefined

  const drawer = (
    <>
      {openId === 'new' && canManage ? (
        <NewOrderRedirect apiPath={API} base={BASE} param={PARAM} createFailedMessage={t('list.createDraftFailed')} />
      ) : null}
      {drawerOrder && pickers ? (
        <OrderDrawer
          order={drawerOrder}
          key={drawerOrder.doc.id}
          initialMode={pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
          kind={KIND}
          parties={pickers[0].rows}
          accounts={pickers[1].rows}
          items={pickers[2].rows}
          taxCodes={(pickers[3])}
          taxGroups={(pickers[4])}
          departments={pickers[5].rows}
          projects={pickers[6].rows}
          segments={pickers[7]}
          subsidiaries={pickers[8]
            .filter((subsidiary) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(subsidiary.id))
            .map((subsidiary) => ({ id: subsidiary.id, name: `${'  '.repeat(subsidiary.depth)}${subsidiary.name}` }))}
          canManage={canManage}
          layout={resolvedForm?.layout}
        />
      ) : null}
    </>
  )

  return (
    <ListPageLayout header={<PageHeader title={t('list.title')} description={t('list.description')} actions={newBtn} />}>
      <RecordListView
        recordType={KIND}
        basePath={BASE}
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newBtn}
      />
    </ListPageLayout>
  )
}
