import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { RecordListView } from '../../../components/record-list-view'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { loadOrder } from '../../api/_order/lib'
import { OrderDrawer } from '../_order/OrderDrawer'
import { NewOrderButton } from '../_order/NewOrderButton'
import { NewOrderRedirect } from '../_order/NewOrderRedirect'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'
import { taxCodeOptions, taxGroupOptions } from '../../../lib/documents'

export const dynamic = 'force-dynamic'

const KIND = 'purchase_order' as const
const BASE = '/purchase-orders'
const PARAM = 'order'
const API = '/api/purchase-orders'

/**
 * Purchase orders. The list is the universal RecordListView; this page owns the
 * header, the New button, and the OrderDrawer flyout. PO→bill conversion is
 * reported in /reports/conversion, not on the list.
 */
export default async function PurchaseOrders({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ap.read')
  const canManage = can(authz, 'ap.create')
  const t = await getTranslations('purchaseOrders')
  const sp = await searchParams
  const openId = pickString(sp[PARAM])

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND) : null,
    openId && openId !== 'new'
      ? Promise.all([
          db.execute(sql`select id, display_name from parties where org_id = ${authz.user.orgId} and custom->>'nsKind' = 'vendor' and is_active order by display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last`) as any,
          db.execute(sql`select id, code, name, default_rate, income_account_id, expense_account_id, tax_code_id, unit from items where org_id = ${authz.user.orgId} and is_active order by name limit 2000`) as any,
          taxCodeOptions(authz.user.orgId),
          taxGroupOptions(authz.user.orgId),
          db.execute(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`) as any,
          db.execute(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`) as any,
          customSegmentOptions(authz.user.orgId),
        ])
      : null,
  ])
  const resolvedForm = openOrder && pickers ? await resolveFormLayout({
    orgId: authz.user.orgId, userId: authz.user.id, recordType: KIND,
    userRoles: [authz.user.role], headerDefs: [], lineDefs: [], explicitLayoutId: pickString(sp.form),
  }) : null

  const newBtn = canManage ? (
    <NewOrderButton apiPath={API} base={BASE} param={PARAM} label={t('list.newButton')} createFailedMessage={t('list.createDraftFailed')} />
  ) : undefined

  const drawer = (
    <>
      {openId === 'new' && canManage ? (
        <NewOrderRedirect apiPath={API} base={BASE} param={PARAM} createFailedMessage={t('list.createDraftFailed')} />
      ) : null}
      {openOrder && pickers ? (
        <OrderDrawer
          order={openOrder as any}
          kind={KIND}
          parties={pickers[0].rows}
          accounts={pickers[1].rows}
          items={pickers[2].rows}
          taxCodes={pickers[3] as any}
          taxGroups={pickers[4] as any}
          departments={pickers[5].rows}
          projects={pickers[6].rows}
          segments={pickers[7]}
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
