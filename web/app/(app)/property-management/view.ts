import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { pickString } from '../../../lib/list-params'
import { loadFieldDefs } from '../../../lib/custom-fields'
import {
  resolveFormLayout,
  resolveListView,
} from '../../../lib/customization/resolve'
import { isFeatureEnabled } from '../../../lib/features'
import { requirePropertyManagementFeature } from '../../../lib/property-management-gate'
import type { CustomFieldDefClient } from '../../../components/custom-field-inputs'
import type { Option } from './workspace-ui'

/**
 * Property management, split into a loader and a spec.
 *
 * The native page renders ONE client island — `PropertyManagementWorkspace` —
 * which owns every tab switch, drawer open/close, fetch (`GET/POST
 * /api/property-management`) and mutation flow in `useState`. Decomposing its
 * health metrics, tab strip, four tab bodies and dozen drawers into spec
 * blocks would render the unfiltered/pre-fetch set and strand the tab state
 * from what it shows (the /reports lesson, also documented on the
 * labor-costing page). There is exactly one workspace; nothing is copied.
 *
 * Loader work copied verbatim from page.tsx: the `ar.read` gate, the
 * `propertyManagement` feature gate (redirects to /admin/setup/features when
 * off — the layout's `notFound` gate agrees when it runs first), the
 * subsidiary scope probes, the `managed_properties` field-def load, the
 * property form-layout + list-view resolution, the `fixedAssets` /
 * `multiCurrency` probes, and the nine option queries in order. The five
 * permission flags are loader-computed booleans; Authz, org id and user id
 * never cross the spec — the slot re-derives nothing here because the
 * workspace persists through the session cookie inside the shared component.
 */

export interface PropertyManagementData {
  title: string
  description: string
  customization: {
    layout: unknown
    forms: Array<{ id: string; name: string }>
    currentFormId: string | null
    fieldDefs: CustomFieldDefClient[]
    listView: unknown
  }
  options: {
    subsidiaries: Option[]
    locations: Option[]
    tenants: Option[]
    incomeAccounts: Option[]
    expenseAccounts: Option[]
    liabilityAccounts: Option[]
    bankAccounts: Option[]
    assets: Option[]
    openInvoices: Option[]
  }
  permissions: {
    manage: boolean
    bill: boolean
    account: boolean
    bulk: boolean
    customize: boolean
  }
  fixedAssetsEnabled: boolean
  multiCurrency: boolean
}

export async function loadPropertyManagement(
  sp: Record<string, string | string[] | undefined>,
): Promise<PropertyManagementData> {
  const authz = await requirePermission('ar.read')
  await requirePropertyManagementFeature(authz.user.orgId)
  const orgId = authz.user.orgId
  const allowed = authz.allowedSubsidiaryIds
    ? [...authz.allowedSubsidiaryIds]
    : null
  const subsidiaryScope =
    allowed === null
      ? sql``
      : sql`and subsidiary_id = any(${`{${allowed.join(',')}}`}::uuid[])`
  const documentSubsidiaryScope =
    allowed === null
      ? sql``
      : sql`and d.subsidiary_id = any(${`{${allowed.join(',')}}`}::uuid[])`
  const fieldDefs = await loadFieldDefs('managed_properties')
  const [resolvedForm, resolvedView, fixedAssetsEnabled, multiCurrency] = await Promise.all([
    resolveFormLayout({
      orgId,
      userId: authz.user.id,
      recordType: 'property',
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs: fieldDefs,
      lineDefs: [],
      explicitLayoutId: pickString(sp.form),
    }),
    resolveListView({
      orgId,
      userId: authz.user.id,
      recordType: 'property',
      viewId: pickString(sp.view),
      showInListDefs: fieldDefs.filter((def) => def.config.showInList),
    }),
    isFeatureEnabled(orgId, 'fixedAssets'),
    isFeatureEnabled(orgId, 'multiCurrency'),
  ])
  const [
    subsidiaries,
    locations,
    tenants,
    incomeAccounts,
    expenseAccounts,
    liabilityAccounts,
    bankAccounts,
    assets,
    openInvoices,
  ] = await Promise.all([
    db.execute<Option>(
      multiCurrency
        ? sql`select id,name,base_currency as currency from subsidiaries where org_id=${orgId} and is_active ${allowed === null ? sql`` : sql`and id = any(${`{${allowed.join(',')}}`}::uuid[])`} order by name`
        : sql`select id,name from subsidiaries where org_id=${orgId} and is_active ${allowed === null ? sql`` : sql`and id = any(${`{${allowed.join(',')}}`}::uuid[])`} order by name`,
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',code,name) as name from locations where org_id=${orgId} and is_active order by code,name`,
    ),
    db.execute<Option>(
      sql`select p.id,p.display_name as name from parties p join customer_roles c on c.party_id=p.id and c.org_id=p.org_id where p.org_id=${orgId} and p.is_active and c.is_active order by p.display_name`,
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type in ('income','income_other') order by number nulls last`,
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type in ('expense','cogs') order by number nulls last`,
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type='liability_current_other' order by number nulls last`,
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type='asset_bank' order by number nulls last`,
    ),
    fixedAssetsEnabled
      ? db.execute<Option>(
          sql`select id,concat_ws(' · ',asset_number,name) as name from fixed_assets where org_id=${orgId} and status not in ('disposed','written_off') ${subsidiaryScope} order by asset_number`,
        )
      : Promise.resolve({ rows: [] }),
    db.execute<Option>(
      sql`select d.id,d.party_id as "partyId",concat_ws(' · ',d.document_number,d.document_date::text) as name,d.open_balance as "openBalance" from documents d where d.org_id=${orgId} and d.kind='customer_invoice' and d.status='posted' and coalesce(d.open_balance,0)>0 ${documentSubsidiaryScope} order by d.document_date desc`,
    ),
  ])
  return {
    // Hard-coded in the native PageHeader, not a message key.
    title: 'Property Management',
    description:
      'Operate properties, leases, rent, CAM reconciliations, and tenant security deposits.',
    customization: {
      layout: resolvedForm.layout,
      forms: resolvedForm.available.map(({ id, name }) => ({ id, name })),
      currentFormId: resolvedForm.row?.id ?? null,
      fieldDefs: fieldDefs as unknown as CustomFieldDefClient[],
      listView: resolvedView.view,
    },
    options: {
      subsidiaries: subsidiaries.rows,
      locations: locations.rows,
      tenants: tenants.rows,
      incomeAccounts: incomeAccounts.rows,
      expenseAccounts: expenseAccounts.rows,
      liabilityAccounts: liabilityAccounts.rows,
      bankAccounts: bankAccounts.rows,
      assets: assets.rows,
      openInvoices: openInvoices.rows,
    },
    permissions: {
      manage: can(authz, 'ar.create'),
      bill: can(authz, 'ar.create'),
      account: can(authz, 'gl.post'),
      bulk: authz.allowedSubsidiaryIds === null,
      customize: can(authz, 'admin.customization.manage'),
    },
    fixedAssetsEnabled,
    multiCurrency,
  }
}

const f = ref<PropertyManagementData>()

export function propertyManagementSpec(data: PropertyManagementData): PageSpec {
  return page({
    route: '/property-management',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      // One client island, like the labor-costing workspace. The loader hands
      // over the customization, option pickers, permission flags and feature
      // probes it already resolved; the component keeps its own tab, drawer,
      // fetch and mutation state exactly as on the native path. No remount
      // key: the native page renders the workspace keyless.
      widgetBlock('property-management-workspace', {
        customization: data.customization,
        options: data.options,
        permissions: data.permissions,
        fixedAssetsEnabled: data.fixedAssetsEnabled,
        multiCurrency: data.multiCurrency,
      }),
    ],
  })
}
