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

export const dynamic = 'force-dynamic'

const KIND = 'quote' as const
const BASE = '/estimates'
const PARAM = 'estimate'
const API = '/api/estimates'

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
  const canManage = can(authz, 'ar.create')
  const t = await getTranslations('estimates')
  const sp = await searchParams
  const openId = pickString(sp[PARAM])

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND) : null,
    openId && openId !== 'new'
      ? Promise.all([
          db.execute(sql`
            select id, display_name from parties
             where (custom->>'nsKind' = 'customer'
                    or exists (select 1 from customer_roles cr where cr.party_id = parties.id))
               and is_active
             order by display_name limit 2000`) as any,
          db.execute(sql`select id, number, name from accounts where type in ('income','income_other') and is_active and not is_summary order by number nulls last`) as any,
          db.execute(sql`select id, code, name, default_rate, income_account_id, expense_account_id, tax_code_id, unit from items where is_active order by name limit 2000`) as any,
          db.execute(sql`
            select tc.id, tc.code, tc.name, coalesce(tr.rate_percent, 0) as rate
              from tax_codes tc
              left join lateral (
                select rate_percent from tax_rates
                 where tax_code_id = tc.id and effective_from <= now()
                 order by effective_from desc limit 1) tr on true
             where tc.is_active order by tc.code`) as any,
          db.execute(sql`select id, name from departments where is_active order by name`) as any,
          db.execute(sql`select id, name from projects where is_active order by name limit 2000`) as any,
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
          taxCodes={pickers[3].rows}
          departments={pickers[4].rows}
          projects={pickers[5].rows}
          segments={pickers[6]}
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
