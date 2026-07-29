import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { RecordListView } from '../../../components/record-list-view'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadFieldTicketDrawerData } from '../../../lib/field-ticket-drawer-data'
import { NewOrderButton } from '../_order/NewOrderButton'
import { FieldTicketDrawer } from './FieldTicketDrawer'

export const dynamic = 'force-dynamic'

const BASE = '/field-tickets'
const PARAM = 'ticket'
const API = '/api/field-tickets'

/**
 * Field tickets — the universal RecordListView (same filters/views/columns as
 * every other list) + the standard instant-create button and transaction
 * flyout. Subordinate to the Projects parent gate on Company Settings → Features.
 */
export default async function FieldTicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('time.read')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) notFound()
  const canManage = can(authz, 'time.manage')
  const t = await getTranslations('fieldTickets')
  const sp = await searchParams
  const openId = pickString(sp[PARAM])
  const drawerData = openId
    ? await loadFieldTicketDrawerData({ authz, ticketId: openId, formLayoutId: pickString(sp.form) })
    : null

  const newBtn = canManage ? (
    <NewOrderButton apiPath={API} base={BASE} param={PARAM} label={t('list.new')} createFailedMessage={t('list.createFailed')} />
  ) : undefined

  const drawer = drawerData ? <FieldTicketDrawer {...drawerData} /> : null

  return (
    <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} actions={newBtn} />}>
      <RecordListView
        recordType="field_ticket"
        basePath={BASE}
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newBtn}
      />
    </ListPageLayout>
  )
}
