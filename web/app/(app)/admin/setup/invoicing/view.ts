import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import type { InvoicingSettingsWorkspace } from './InvoicingSettingsWorkspace'

/**
 * Company Settings → Invoicing setup, split into a loader and a spec.
 *
 * The whole page is one client island (`InvoicingSettingsWorkspace`): the
 * workflow list, the project-policy card and the invoice-controls grid render
 * from seven props and own no URL affordance — the page reads no search
 * params, so there is exactly ONE page state per dataset. None of the surface
 * decomposes into spec blocks: the status column is a conditional PAIR (an
 * "Enabled/Disabled" badge beside an optional "N active · M paused" count
 * line, an "Open subscriptions" button only when the gate is on), the note
 * lines and action rows are presence-gated per workflow, the metric tiles
 * mute when the Projects gate is off, and the footer CTA swaps its href AND
 * its label on the same flag — seven conditional pairs/branching labels, not
 * presence. A spec `table` block is wrong twice over: variant 'app' renders
 * different thead/td markup (the native list is a hand-rolled `divide-y`
 * div stack), and it cannot carry the per-row icon tiles, badges, or the
 * client Button-as-Link actions. So the island arrives whole through one
 * widget — the `crm-setup-workspace` / `bank-feeds-workspace` precedent —
 * and the loader binds every prop verbatim from the native page.
 *
 * Loader work copied VERBATIM from page.tsx: the `admin.setup.manage` gate,
 * the `subscriptionBilling` + `projects` feature probes, the project_types
 * profile-count aggregation and the subscriptions active/paused counts, with
 * the same Number(x ?? 0) normalization. Nothing travels through the spec
 * except plain data.
 *
 * Serializability note: every loader field is a boolean or a number — the
 * page has no dates, money, rows, or params — so there is nothing to format
 * and no `currentParams` to thread (the page reads no search params; the
 * loader is handed the request's params and reads none of them).
 */

type InvoicingWorkspaceProps = Parameters<typeof InvoicingSettingsWorkspace>[0]

export interface InvoicingSetupData {
  subscriptionBillingEnabled: boolean
  activeSubscriptions: number
  pausedSubscriptions: number
  projectsEnabled: boolean
  activeProjectTypes: number
  standardProjectTypes: number
  applicationProjectTypes: number
}

export async function loadInvoicingSetup(): Promise<InvoicingSetupData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const [subscriptionBillingEnabled, projectsEnabled, projectTypes, subscriptionCounts] = await Promise.all([
    isFeatureEnabled(orgId, 'subscriptionBilling'),
    isFeatureEnabled(orgId, 'projects'),
    db.execute<{ active: number; standard: number; applications: number }>(sql`
      select count(*) filter (where is_active)::int as active,
             count(*) filter (
               where is_active
                 and invoicing_profile->>'billingProcedure' = 'standard'
             )::int as standard,
             count(*) filter (
               where is_active
                 and invoicing_profile->>'billingProcedure' = 'application_for_payment'
             )::int as applications
        from project_types
       where org_id = ${orgId}`),
    db.execute<{ active: number; paused: number }>(sql`
      select count(*) filter (where status = 'active')::int as active,
             count(*) filter (where status = 'paused')::int as paused
        from subscriptions
       where org_id = ${orgId}`),
  ])
  const typeCounts = projectTypes.rows[0]
  const subscriptions = subscriptionCounts.rows[0]

  return {
    subscriptionBillingEnabled,
    activeSubscriptions: Number(subscriptions?.active ?? 0),
    pausedSubscriptions: Number(subscriptions?.paused ?? 0),
    projectsEnabled,
    activeProjectTypes: Number(typeCounts?.active ?? 0),
    standardProjectTypes: Number(typeCounts?.standard ?? 0),
    applicationProjectTypes: Number(typeCounts?.applications ?? 0),
  }
}

export function invoicingSetupSpec(data: InvoicingSetupData): PageSpec {
  // The widget takes the workspace props flat (no nested bag); typing the
  // object against the component's own props keeps the coordinator's verbatim
  // wiring compiler-checked — a prop rename breaks here, not at render time.
  const props: InvoicingWorkspaceProps = {
    subscriptionBillingEnabled: data.subscriptionBillingEnabled,
    activeSubscriptions: data.activeSubscriptions,
    pausedSubscriptions: data.pausedSubscriptions,
    projectsEnabled: data.projectsEnabled,
    activeProjectTypes: data.activeProjectTypes,
    standardProjectTypes: data.standardProjectTypes,
    applicationProjectTypes: data.applicationProjectTypes,
  }
  return page({
    route: '/admin/setup/invoicing',
    // The setup workspace layout renders its own shell (sticky PageHeader +
    // SetupNav rail) around every setup page; wrapping it in a second page
    // layout would nest the chrome — the crm/bank-feeds precedent.
    layout: 'bare',
    header: [],
    body: [widgetBlock('invoicing-setup-workspace', { ...props })],
  })
}
