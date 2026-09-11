import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { requireSubcontractsFeature } from '../../../lib/subcontracts-gate'

/**
 * Subcontracts, split into a loader and a spec.
 *
 * The native page renders ONE client island — `SubcontractsWorkspace` — which
 * owns every tab switch, drawer open/close, fetch (`GET/POST
 * /api/subcontracts`) and mutation flow in `useState`. Decomposing its
 * register table, six drawer tabs, SOV/change-order/application/retainage/
 * control tables and half-dozen drawers into spec blocks would render the
 * unfiltered/pre-fetch set and strand the client state from what it shows
 * (the /reports lesson, also documented on the labor-costing and
 * property-management pages). There is exactly one workspace; nothing is
 * copied.
 *
 * Loader work copied verbatim from page.tsx: the `ap.read` gate, the
 * `subcontracts` feature gate (redirects to /admin/setup/features when off —
 * the layout's `notFound` gate agrees when it runs first), the
 * `multiCurrency` probe, and the four option queries in order (projects,
 * vendors with optional currency, expense/COGS accounts, parties capped at
 * 2000). The four permission flags are loader-computed booleans; Authz, org
 * id and user id never cross the spec — the workspace persists through the
 * session cookie inside the shared component.
 */

export type SubcontractOption = {
  id: string
  name: string
  currency?: string | null
}

export interface SubcontractsData {
  title: string
  description: string
  projects: SubcontractOption[]
  vendors: SubcontractOption[]
  expenseAccounts: SubcontractOption[]
  parties: SubcontractOption[]
  multiCurrency: boolean
  permissions: {
    create: boolean
    approve: boolean
    post: boolean
    pay: boolean
  }
}

export async function loadSubcontracts(
  _sp: Record<string, string | string[] | undefined>,
): Promise<SubcontractsData> {
  const authz = await requirePermission('ap.read')
  await requireSubcontractsFeature(authz.user.orgId)
  const orgId = authz.user.orgId
  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const [projects, vendors, accounts, parties] = await Promise.all([
    db.execute<SubcontractOption>(sql`select id, name from projects where org_id = ${orgId} and is_active and status not in ('closed','cancelled') order by name`),
    multiCurrency
      ? db.execute<SubcontractOption>(sql`select p.id, p.display_name as name, vr.currency from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id where p.org_id = ${orgId} and p.is_active and vr.is_active order by p.display_name`)
      : db.execute<SubcontractOption>(sql`select p.id, p.display_name as name from parties p join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id where p.org_id = ${orgId} and p.is_active and vr.is_active order by p.display_name`),
    db.execute<SubcontractOption>(sql`select id, concat_ws(' · ', number, name) as name from accounts where org_id = ${orgId} and is_active and not is_summary and type in ('expense','cogs') order by number nulls last`),
    db.execute<SubcontractOption>(sql`select id, display_name as name from parties where org_id = ${orgId} and is_active order by display_name limit 2000`),
  ])
  return {
    // Hard-coded in the native PageHeader, not a message key.
    title: 'Subcontracts',
    description: 'Vendor commitments, progress applications, retainage, and payment controls.',
    projects: projects.rows as SubcontractOption[],
    vendors: vendors.rows as SubcontractOption[],
    expenseAccounts: accounts.rows as SubcontractOption[],
    parties: parties.rows as SubcontractOption[],
    multiCurrency,
    permissions: {
      create: can(authz, 'ap.create'),
      approve: can(authz, 'ap.approve'),
      post: can(authz, 'ap.post'),
      pay: can(authz, 'ap.pay'),
    },
  }
}

const f = ref<SubcontractsData>()

export function subcontractsSpec(data: SubcontractsData): PageSpec {
  return page({
    route: '/subcontracts',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      // One client island, like the labor-costing and property-management
      // workspaces. The loader hands over the four option pickers, the
      // permission flags and the multiCurrency probe it already resolved; the
      // component keeps its own tab, drawer, fetch and mutation state exactly
      // as on the native path. No remount key: the native page renders the
      // workspace keyless.
      widgetBlock('subcontracts-workspace', {
        projects: data.projects,
        vendors: data.vendors,
        expenseAccounts: data.expenseAccounts,
        parties: data.parties,
        multiCurrency: data.multiCurrency,
        permissions: data.permissions,
      }),
    ],
  })
}
