import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { loadParty } from '../../../api/parties/_lib'
import { subsidiaryUiOptions, subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import type { PartyDrawer, PartyTab } from '../../parties/PartyDrawer'

/**
 * An entity role list (customers, vendors, employees), split into a loader
 * and a spec.
 *
 * Almost all of the page is the universal entity list; what is page-specific
 * is the drawer SLOT, which the native page fills with a fragment of up to
 * three components — a create-redirect, the party flyout, and a related
 * transaction flyout. A spec cannot express a fragment, so the slot takes a
 * LIST of widget names and the host renders them in order (the same
 * arrangement the projects page uses).
 *
 * The one wrinkle relative to /parties is the new-party button: it carries a
 * per-role `basePath`, `role` and translated `label` ("New customer", not
 * "New party"), so the header action and the empty-state action both name a
 * prop-carrying `new-role-party` widget rather than the prop-less
 * `new-party` one. The props are loader-resolved strings; no component
 * reference or capability object crosses the spec boundary.
 */

// URL slug (plural) → role key (singular) + badge variant. Display copy lives
// in the `entities` catalog under roles.<slug>.* and is translated at render.
const ROLES = {
  customers: { role: 'customer', badge: 'default' as const },
  vendors: { role: 'vendor', badge: 'secondary' as const },
  employees: { role: 'employee', badge: 'outline' as const },
} as const
type PartyDrawerProps = Parameters<typeof PartyDrawer>[0]
type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

async function loadWorkerCompGroups(orgId: string, enabled: boolean): Promise<{ rows: ElementOf<PartyDrawerProps['workerCompGroups']>[] }> {
  if (!enabled) return { rows: [] }
  const result = await db.execute<ElementOf<PartyDrawerProps['workerCompGroups']>>(sql`select id, name from worker_comp_groups where org_id = ${orgId} and is_active order by name`)
  return { rows: result.rows }
}

export interface EntityRoleData {
  recordType: 'customer' | 'vendor' | 'employee'
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  newParty: { basePath: string; role: 'customer' | 'vendor' | 'employee'; label: string }
  showNewRedirect: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
  txnDrawer: { id: string; kind: string; partyId: string; formLayoutId?: string } | null
}

export async function loadEntityRole(
  slug: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<EntityRoleData> {
  const meta = ROLES[slug as keyof typeof ROLES]
  if (!meta) notFound()
  const role = meta.role
  const basePath = `/entities/${slug}`
  const t = await getTranslations('entities')
  const newLabel = t(`roles.${slug}.newLabel`)

  const authz = await requirePermission('parties.read')
  const payrollEnabled = await isFeatureEnabled(authz.user.orgId, 'payroll')
  const multiCurrency = await isFeatureEnabled(authz.user.orgId, 'multiCurrency')
  const crmEnabled = await isFeatureEnabled(authz.user.orgId, 'crm')
  const canManage = can(authz, 'parties.manage')
  const orgId = authz.user.orgId

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
    partyId && partyId !== 'new' && isUuid(partyId) ? loadParty(partyId, orgId, authz.allowedSubsidiaryIds) : null,
    partyId
      ? Promise.all([
          db.execute<ElementOf<PartyDrawerProps['paymentTerms']>>(sql`select id, name from payment_terms where org_id = ${orgId} and is_active order by name`),
          db.execute<ElementOf<PartyDrawerProps['departments']>>(sql`select id, name from departments where org_id = ${orgId} and is_active order by name`),
          db.execute<ElementOf<PartyDrawerProps['trades']>>(sql`select id, name from trades where org_id = ${orgId} and is_active order by name`),
          loadFieldDefs('parties'),
          subsidiaryUiOptions(orgId).then((options) => authz.allowedSubsidiaryIds
            ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
            : options),
          db.execute<ElementOf<PartyDrawerProps['accounts']>>(sql`select id, name, type, concat_ws(' · ', number, name) as label from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`),
          db.execute<ElementOf<PartyDrawerProps['taxCodes']>>(sql`select id, name, concat_ws(' · ', code, name) as label from tax_codes where org_id = ${orgId} and is_active order by code`),
          db.execute<ElementOf<PartyDrawerProps['salesReps']>>(sql`select p.id, p.display_name as name from parties p join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active where p.org_id = ${orgId} and p.is_active
            ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })} order by p.display_name`),
          loadWorkerCompGroups(orgId, payrollEnabled),
        ])
      : null,
  ])
  const resolvedPartyForm = openParty && pickers
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: role,
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: (pickers[3]),
        lineDefs: [],
        explicitLayoutId: pickString(sp.partyForm),
      })
    : null

  return {
    recordType: role,
    title: t(`roles.${slug}.title`),
    description: t(`roles.${slug}.description`),
    canManage,
    currentParams: sp,
    newParty: { basePath, role, label: newLabel },
    showNewRedirect: partyId === 'new' && canManage,
    drawer: openParty && pickers
      ? {
          remountKey: String(openParty.party.id),
          payload: openParty as unknown as PartyDrawerProps['payload'],
          canManage,
          canReadActivities: crmEnabled && can(authz, 'crm.activities.read'),
          canManageWages: can(authz, 'admin.setup.manage'),
          canManagePayroll: payrollEnabled && can(authz, 'payroll.manage'),
          payrollEnabled,
          multiCurrency,
          role,
          initialTab: partyTab,
          initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view',
          basePath,
          paymentTerms: pickers[0].rows,
          departments: pickers[1].rows,
          trades: pickers[2].rows,
          workerCompGroups: pickers[8].rows,
          fieldDefs: pickers[3] as unknown as PartyDrawerProps['fieldDefs'],
          subsidiaries: pickers[4],
          accounts: pickers[5].rows,
          taxCodes: pickers[6].rows,
          salesReps: pickers[7].rows,
          layout: resolvedPartyForm?.layout,
          forms: resolvedPartyForm?.available ?? [],
          currentFormId: resolvedPartyForm?.row?.id ?? null,
          recordType: role,
          canCustomize: can(authz, 'admin.customization.manage'),
        }
      : null,
    txnDrawer: openParty && partyTransactionId && isUuid(partyTransactionId) && partyTransactionKind
      ? {
          id: partyTransactionId,
          kind: partyTransactionKind,
          partyId: String(openParty.party.id),
          formLayoutId: pickString(sp.form),
        }
      : null,
  }
}

const f = ref<EntityRoleData>()

export function entityRoleSpec(data: EntityRoleData): PageSpec {
  const newParty = { widget: 'new-role-party', props: { ...data.newParty } }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newParty.widget, newParty.props, f('canManage'))],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: data.recordType,
        sp: data.currentParams,
        emptyAction: data.canManage ? newParty : null,
        // Rendered in the native page's order: the create-redirect first, then
        // the record flyout, then the transaction flyout stacked over it.
        drawer: [
          data.showNewRedirect ? { widget: 'new-role-party-redirect', props: { ...data.newParty } } : null,
          data.drawer ? { widget: 'party-drawer', props: { drawer: data.drawer } } : null,
          data.txnDrawer
            ? { widget: 'related-txn-drawer', props: { drawer: data.txnDrawer } }
            : null,
        ].filter(Boolean),
      }),
    ],
  })
}
