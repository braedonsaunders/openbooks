import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { loadParty } from '../../../api/parties/_lib'
import { subsidiaryUiOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { NewPartyButton } from '../../parties/NewPartyButton'
import { NewPartyRedirect } from '../../parties/NewPartyRedirect'
import { PartyDrawer, type PartyTab } from '../../parties/PartyDrawer'
import { RelatedTransactionDrawer } from '../../../../components/related-transaction-drawer'
import { EntityListView } from '../../../../components/entity-list-view'

export const dynamic = 'force-dynamic'

// URL slug (plural) → role key (singular) + badge variant. Display copy lives
// in the `entities` catalog under roles.<slug>.* and is translated at render.
const ROLES = {
  customers: { role: 'customer', badge: 'default' as const },
  vendors: { role: 'vendor', badge: 'secondary' as const },
  employees: { role: 'employee', badge: 'outline' as const },
} as const

export default async function EntityRole({
  params,
  searchParams,
}: {
  params: Promise<{ role: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { role: slug } = await params
  const meta = ROLES[slug as keyof typeof ROLES]
  if (!meta) notFound()
  const role = meta.role
  const basePath = `/entities/${slug}`
  const t = await getTranslations('entities')
  const newLabel = t(`roles.${slug}.newLabel`)

  const authz = await requirePermission('parties.read')
  const payrollEnabled = await isFeatureEnabled(authz.user.orgId, 'payroll')
  const canManage = can(authz, 'parties.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const partyId = typeof sp.party === 'string' ? sp.party : undefined
  const partyTransactionId = pickString(sp.partyTxn)
  const partyTransactionKind = pickString(sp.partyTxnKind)
  const requestedPartyTab = pickString(sp.partyTab)
  const partyTab: PartyTab = requestedPartyTab === 'transactions' || requestedPartyTab === 'activities' || requestedPartyTab === 'contacts'
    || requestedPartyTab === 'addresses' || requestedPartyTab === 'accounting' || requestedPartyTab === 'wages'
    || requestedPartyTab === 'payroll'
    ? requestedPartyTab
    : 'overview'
  const [openParty, pickers] = await Promise.all([
    partyId && partyId !== 'new' && isUuid(partyId) ? loadParty(partyId, orgId) : null,
    partyId
      ? Promise.all([
          db.execute(sql`select id, name from payment_terms where org_id = ${orgId} and is_active order by name`) as any,
          db.execute(sql`select id, name from departments where org_id = ${orgId} and is_active order by name`) as any,
          db.execute(sql`select id, name from trades where org_id = ${orgId} and is_active order by name`) as any,
          loadFieldDefs('parties'),
          subsidiaryUiOptions(orgId),
          db.execute(sql`select id, name, type, concat_ws(' · ', number, name) as label from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`) as any,
          db.execute(sql`select id, name, concat_ws(' · ', code, name) as label from tax_codes where org_id = ${orgId} and is_active order by code`) as any,
          db.execute(sql`select p.id, p.display_name as name from parties p join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active where p.org_id = ${orgId} and p.is_active order by p.display_name`) as any,
          db.execute(sql`select id, name from worker_comp_groups where org_id = ${orgId} and is_active order by name`) as any,
        ])
      : null,
  ])
  const resolvedPartyForm = openParty && pickers
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: role,
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: pickers[3] as any,
        lineDefs: [],
        explicitLayoutId: pickString(sp.partyForm),
      })
    : null

  const partyDrawers = (
    <>
      {partyId === 'new' && canManage ? <NewPartyRedirect basePath={basePath} role={role} /> : null}
      {openParty && pickers ? (
        <PartyDrawer
          key={String(openParty.party.id)}
          payload={openParty as any}
          canManage={canManage}
          canReadActivities={can(authz, 'crm.activities.read')}
          canManageWages={can(authz, 'admin.setup.manage')}
          canManagePayroll={payrollEnabled && can(authz, 'payroll.manage')}
          role={role}
          initialTab={partyTab}
          initialMode={pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
          basePath={basePath}
          paymentTerms={pickers[0].rows}
          departments={pickers[1].rows}
          trades={pickers[2].rows}
          workerCompGroups={pickers[8].rows}
          fieldDefs={pickers[3] as any}
          subsidiaries={pickers[4]}
          accounts={pickers[5].rows}
          taxCodes={pickers[6].rows}
          salesReps={pickers[7].rows}
          layout={resolvedPartyForm?.layout}
          forms={resolvedPartyForm?.available ?? []}
          currentFormId={resolvedPartyForm?.row?.id ?? null}
          recordType={role}
          canCustomize={can(authz, 'admin.customization.manage')}
        />
      ) : null}
      {openParty && partyTransactionId && isUuid(partyTransactionId) && partyTransactionKind ? (
        <RelatedTransactionDrawer
          id={partyTransactionId}
          kind={partyTransactionKind}
          partyId={String(openParty.party.id)}
          authz={authz}
          formLayoutId={pickString(sp.form)}
        />
      ) : null}
    </>
  )

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t(`roles.${slug}.title`)}
          description={t(`roles.${slug}.description`)}
          actions={canManage ? <NewPartyButton basePath={basePath} role={role} label={newLabel} /> : undefined}
        />
      }
    >
      <EntityListView
        recordType={role}
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        emptyAction={canManage ? <NewPartyButton basePath={basePath} role={role} label={newLabel} /> : undefined}
        drawer={partyDrawers}
      />
    </ListPageLayout>
  )
}
