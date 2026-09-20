import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { customerGroupTabs, hrmGroupTabs } from '../../../../components/module-home/group-tabs'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { loadComplianceClasses, loadVendorComplianceClass } from '../../../../lib/compliance'
import { loadParty } from '../../../api/parties/_lib'
import { findEmploymentsByParty } from '@openbooks/engine/src/hrm/employment-read.ts'
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
  /**
   * The Customers-group route strip. Only the customers slug belongs to that
   * group — vendors and employees are Purchasing and Operations records that
   * happen to share this renderer, so they get no strip.
   */
  tabs: Awaited<ReturnType<typeof customerGroupTabs | typeof hrmGroupTabs>>
  /**
   * On a lead or prospect segment, New mints a relationship draft at that
   * stage instead of a customer with an AR role. Null when the segment is
   * customers or All, CRM is off, or the viewer cannot create accounts.
   */
  newAccount: { label: string; failed: string; lifecycleStage: 'lead' | 'prospect' } | null
  /**
   * Whether the party factory belongs on this segment at all. On a lead or
   * prospect segment it does not: it would mint a customer with an AR role,
   * so a viewer who may see leads but not create them gets no button rather
   * than a "New lead" button that makes a customer.
   */
  showNewParty: boolean
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
  const tCrm = await getTranslations('crm')

  const authz = await requirePermission('parties.read')
  const payrollEnabled = await isFeatureEnabled(authz.user.orgId, 'payroll')
  const multiCurrency = await isFeatureEnabled(authz.user.orgId, 'multiCurrency')
  const crmEnabled = await isFeatureEnabled(authz.user.orgId, 'crm')
  const complianceEnabled = await isFeatureEnabled(authz.user.orgId, 'subcontractorCompliance')
  // The Employment tab's double gate: the HRM feature switch plus the
  // employment read grant. The drawer shows the tab only when both hold.
  const hrmEnabled = await isFeatureEnabled(authz.user.orgId, 'hrm')
  const canReadHrm = hrmEnabled && can(authz, 'hrm.employment.read')
  const canManage = can(authz, 'parties.manage')
  const orgId = authz.user.orgId
  const canReadCrmAccounts = crmEnabled && can(authz, 'crm.accounts.read')
  const canManageCrmAccounts = crmEnabled && can(authz, 'crm.accounts.manage')

  // The lifecycle segment the customer list is on. It is the SAME `status`
  // param the list's own chips write, so the header follows the chips: the
  // title names the segment and New mints the right kind of record. The
  // list's own default is `customer`, so an absent param means customers.
  const stageParam = pickString(sp.status)
  const segment = slug === 'customers' && canReadCrmAccounts
    && (stageParam === 'lead' || stageParam === 'prospect' || stageParam === 'all')
    ? stageParam
    : 'customer'
  const segmentTitle = segment === 'customer'
    ? t(`roles.${slug}.title`)
    : segment === 'all'
      ? tCrm('accounts.allTitle')
      : tCrm(`accounts.${segment}.title`)
  const segmentDescription = segment === 'customer'
    ? t(`roles.${slug}.description`)
    : segment === 'all'
      ? tCrm('accounts.allDescription')
      : tCrm(`accounts.${segment}.description`)
  const newLabel = t(`roles.${slug}.newLabel`)

  const partyId = typeof sp.party === 'string' ? sp.party : undefined
  const partyTransactionId = pickString(sp.partyTxn)
  const partyTransactionKind = pickString(sp.partyTxnKind)
  const requestedPartyTab = pickString(sp.partyTab)
  const partyTab: PartyTab = requestedPartyTab === 'transactions' || requestedPartyTab === 'activities' || requestedPartyTab === 'contacts'
    || requestedPartyTab === 'addresses' || requestedPartyTab === 'accounting' || requestedPartyTab === 'wages'
    || requestedPartyTab === 'payroll' || requestedPartyTab === 'employment' || requestedPartyTab === 'compliance'
    || requestedPartyTab === 'pulse' || requestedPartyTab === 'relationship'
    || requestedPartyTab === 'invoicing' || requestedPartyTab === 'pricing'
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
  // The open account's lifecycle stage. The flyout needs it before its first
  // save: on a lead or prospect it must NOT force the AR customer role on.
  // Deliberately NOT filtered on `is_active`: a relationship draft's profile
  // is inactive until the draft is named, and that is exactly the save that
  // must not mint an AR role. The stage is a property of the record, not of
  // whether it is live yet.
  const openLifecycleStage = crmEnabled && openParty
    ? ((await db.execute<{ lifecycle_stage: string }>(sql`
        select lifecycle_stage from crm_account_profiles
         where org_id = ${orgId} and party_id = ${String(openParty.party.id)} limit 1`))
        .rows[0]?.lifecycle_stage ?? null)
    : null

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
    title: segmentTitle,
    description: segmentDescription,
    canManage,
    currentParams: sp,
    newParty: { basePath, role, label: newLabel },
    // The employees list is a sibling tab of the Human Resources workspace
    // whenever the workspace exists for this viewer (feature on plus the
    // employment read grant), so the strip looks identical from either side.
    tabs: slug === 'customers'
      ? await customerGroupTabs(authz, '/entities/customers')
      : slug === 'employees' && canReadHrm
        ? await hrmGroupTabs(authz, '/entities/employees')
        : [],
    newAccount: (segment === 'lead' || segment === 'prospect') && can(authz, 'crm.accounts.create')
      ? { label: tCrm(`accounts.${segment}.new`), failed: tCrm('feedback.createFailed'), lifecycleStage: segment }
      : null,
    showNewParty: segment !== 'lead' && segment !== 'prospect',
    showNewRedirect: partyId === 'new' && canManage,
    drawer: openParty && pickers
      ? {
          remountKey: String(openParty.party.id),
          payload: openParty as unknown as PartyDrawerProps['payload'],
          canManage,
          complianceEnabled,
          canManageCompliance: can(authz, 'compliance.manage'),
          // F-t04-003: the vendor Compliance tab — drawer-open vendors only.
          compliance: complianceEnabled && role === 'vendor' && partyId && isUuid(partyId)
            ? {
                classId: await loadVendorComplianceClass(orgId, partyId),
                classes: await loadComplianceClasses(orgId),
              }
            : null,
          canReadActivities: crmEnabled && can(authz, 'crm.activities.read'),
          canManageActivities: crmEnabled && can(authz, 'crm.activities.manage'),
          // The party's scoped employments for the Employment tab (null =
          // gated, so the tab never renders without the read surface behind
          // it). Employee drawers only: other roles never resolve HRM.
          hrm: canReadHrm && role === 'employee' && partyId && isUuid(partyId)
            ? {
                employmentIds: [
                  ...(await findEmploymentsByParty({
                    orgId,
                    actorId: authz.user.id,
                    workerPartyId: partyId,
                  })),
                ],
                // Authoring rides the manage grant; readers see the request
                // list only. The change-request routes re-check this grant.
                canManageHrm: can(authz, 'hrm.employment.manage'),
              }
            : null,
          canReadCrmAccounts,
          canManageCrmAccounts,
          lifecycleStage: openLifecycleStage,
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
  // On a lead/prospect segment the create action mints a relationship draft
  // (no AR role) through the CRM factory; on the customer segment it is the
  // party create it has always been. One button, segment-shaped.
  const newParty = data.newAccount
    ? {
        widget: 'crm-new-button',
        props: {
          apiPath: '/api/crm/accounts/draft',
          basePath: data.newParty.basePath,
          param: 'party',
          label: data.newAccount.label,
          failed: data.newAccount.failed,
          body: { lifecycleStage: data.newAccount.lifecycleStage },
        },
      }
    : data.showNewParty
      ? { widget: 'new-role-party', props: { ...data.newParty } }
      : null
  // The relationship factory has its own permission (crm.accounts.create,
  // already resolved into `newAccount`), so that button is unconditional
  // once present; the party factory keeps its parties.manage ref.
  const canCreate = newParty != null && (data.newAccount != null || data.canManage)
  return page({
    route: '/entities/[role]',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          ...(newParty ? [widget(newParty.widget, newParty.props, data.newAccount ? undefined : f('canManage'))] : []),
          ...(data.tabs.length ? [widget('module-home-tabs', { tabs: data.tabs })] : []),
        ],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: data.recordType,
        sp: data.currentParams,
        emptyAction: canCreate ? newParty : null,
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
