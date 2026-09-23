import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";

/**
 * Vendor-bill release policy (owner decision: auto-release stays the default,
 * made explicit). An org may opt into "Require approval before vendor bills
 * release" (Company Settings → Setup, stored at
 * `orgs.settings.approvals.requireVendorBillApproval`, default OFF). When the
 * requirement is ON and no approval flow gates the bill, the engine refuses
 * the release by name and the bill stays submitted — never released.
 */

/** Refusal text for a gated-by-policy vendor bill with no matching flow. */
export const VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE =
  "Approval is required before vendor bills release, and no approval flow is configured — set one up in Flows or turn off the requirement in Setup";

/** The document kind this policy applies to. */
export const VENDOR_BILL_KIND = "vendor_bill";

/**
 * Is the org's "require approval before vendor bills release" switch on?
 * Absent (or anything but the JSON boolean true) reads as OFF — today's
 * auto-release behaviour. The comparison is strict text, never a boolean
 * cast: Postgres accepts 'yes'/'on'/'1' as true, so a cast would let junk
 * enable the gate (fail open toward refusals).
 */
export async function isVendorBillApprovalRequired(
  orgId: string,
  executor: SqlExecutor = db,
): Promise<boolean> {
  const rows = (await executor.execute<{ required: boolean | null }>(sql`
    select coalesce((settings->'approvals'->>'requireVendorBillApproval') = 'true', false) as required
      from orgs where id = ${orgId}
  `)).rows;
  return rows[0]?.required === true;
}

/**
 * Does the org have an enabled vendor-bill flow that can actually gate —
 * i.e. its graph carries a gate node? Pure-automation flows (no gates) never
 * own a submit, so they must not silence the "no approval flow configured"
 * warning on the Setup page.
 */
export async function hasVendorBillApprovalFlow(
  orgId: string,
  executor: SqlExecutor = db,
): Promise<boolean> {
  const rows = (await executor.execute<{ configured: boolean }>(sql`
    select exists(
      select 1 from flows
       where org_id = ${orgId}
         and subject_kind = ${VENDOR_BILL_KIND}
         and enabled
         and exists (
           select 1
             from jsonb_array_elements(coalesce(graph->'nodes', '[]'::jsonb)) as node
            where node->'data'->>'kind' = 'gate'
         )
    ) as configured
  `)).rows;
  return rows[0]?.configured === true;
}
