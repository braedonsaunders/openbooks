import 'server-only'

import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireProjectsFeature } from '../../../../../lib/projects-gate'
import { isFeatureEnabled } from '../../../../../lib/features'
import type { ProjectTypesWorkspace, ProjectTypeRow } from './ProjectTypesWorkspace'

/**
 * Project types setup, split into a loader and a spec.
 *
 * The native page is a permission gate + the projects feature gate + a
 * four-way types/dimensions/income-accounts/fieldTickets fan-out, then the
 * whole surface renders inside ONE client island
 * (`ProjectTypesWorkspace`): the type list, the four sub-tabs (general /
 * profitability / invoicing / backup), the P&L layout editor, the chips and
 * enum selects all own `useState` (selection, sub-tab, draft, busy,
 * financial effective-from/reason), and save/delete fire `fetch`
 * POST/PATCH/DELETE mutations with confirm/toast + `router.refresh()`.
 * Decomposing the list or the editor into spec blocks would strand the
 * inputs from the draft they edit (the labor-costing / bank-feeds /
 * features lesson) — so the island arrives whole through one widget.
 *
 * Loader work copied VERBATIM from page.tsx: the `admin.setup.manage`
 * gate, the projects feature redirect, the `businessToday` probe, and the
 * four-way Promise.all with the lateral effective-version join
 * (effective_from <= today, open-ended or effective_to >= today, latest
 * first), the distinct-dimension list, the income/income_other account
 * picker (active, non-summary, ordered by number, limit 500), and the
 * `fieldTickets` flag. Income accounts travel as data even though the
 * current workspace signature destructures them away — the API round-trip
 * and a future picker both key on them.
 */

type ProjectTypesWorkspaceProps = Parameters<typeof ProjectTypesWorkspace>[0]

export interface ProjectTypesData {
  types: ProjectTypeRow[]
  dimensions: string[]
  incomeAccounts: ProjectTypesWorkspaceProps['incomeAccounts']
  fieldTicketsEnabled: boolean
}

export async function loadProjectTypes(): Promise<ProjectTypesData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  await requireProjectsFeature(orgId)
  const today = await businessToday(orgId)
  const [typesRes, dimsRes, acctRes, fieldTicketsEnabled] = await Promise.all([
    db.execute(sql`
      select id, key, name, description, is_built_in as "isBuiltIn", is_active as "isActive",
             sort_order as "sortOrder", billing_method as "billingMethod",
             version.financial_profile as "financialProfile",
             version.effective_from::text as "financialProfileEffectiveFrom",
             invoicing_profile as "invoicingProfile", backup_profile as "backupProfile"
        from project_types
        left join lateral (
          select v.financial_profile, v.effective_from
            from project_financial_profile_versions v
           where v.org_id = project_types.org_id
             and v.project_type_id = project_types.id
             and v.effective_from <= ${today}
             and (v.effective_to is null or v.effective_to >= ${today})
           order by v.effective_from desc
           limit 1
        ) version on true
       where project_types.org_id = ${orgId}
       order by sort_order, name`),
    db.execute(sql`select distinct dimension from account_groups where org_id = ${orgId} order by dimension`),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and coalesce(is_summary,false) = false
         and type in ('income','income_other') order by number limit 500`),
    isFeatureEnabled(orgId, 'fieldTickets'),
  ])

  return {
    types: (typesRes as unknown as { rows: ProjectTypeRow[] }).rows,
    dimensions: (dimsRes as unknown as { rows: { dimension: string }[] }).rows.map((r) => r.dimension),
    incomeAccounts: (acctRes as unknown as { rows: { id: string; number: string; name: string }[] }).rows,
    fieldTicketsEnabled,
  }
}

export function projectTypesSpec(data: ProjectTypesData): PageSpec {
  return page({
    route: '/admin/setup/project-types',
    // The setup workspace renders its own shell around every setup page, so
    // a second page layout would nest the chrome. And the
    // `grid gap-5 lg:grid-cols-[16rem_1fr]` wrapper belongs to
    // ProjectTypesWorkspace itself — the spec must NOT place it too, or the
    // page renders that div twice (the bank-feeds `max-w-4xl` precedent).
    layout: 'bare',
    header: [],
    body: [
      // The whole page is one client island, passed whole like the crm /
      // bank-feeds / features workspaces: the type list, the four sub-tabs,
      // the P&L layout editor and the save/delete flows all own client
      // behavior (selection state, draft state, fetch mutations, confirm,
      // toast, router.refresh) a spec cannot name. Every prop is
      // loader-resolved data; the entry only binds it.
      widgetBlock('project-types-workspace', {
        types: data.types,
        dimensions: data.dimensions,
        incomeAccounts: data.incomeAccounts,
        fieldTicketsEnabled: data.fieldTicketsEnabled,
      }),
    ],
  })
}
