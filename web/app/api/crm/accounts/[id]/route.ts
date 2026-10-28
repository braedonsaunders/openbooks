import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { crmSharedScope } from "@/lib/crm-scope";
import { isUuid } from "@/lib/list-params";
import { loadCrmAccount } from "@/lib/crm";
import { notFound } from "@/lib/api/responses";
import { startCrmAccountTracking } from "@/lib/crm/actions";
import { patchCrmAccount, requestBodySchema } from "@/lib/crm/account-actions";

export const runtime = "nodejs";

/**
 * The relationship record for one party, plus the pickers its editor needs.
 *
 * `options` rides along because the editor is a TAB of the party flyout, not
 * a page with its own server loader: one round trip has to answer both "what
 * is this relationship" and "what may it become", or the tab renders selects
 * with no choices in them. `account: null` is a 200, not a 404 — a customer
 * created outside CRM simply has no profile yet, and the tab offers to start
 * one (see POST).
 */
export const GET = defineRoute({
  permission: "crm.accounts.read",
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const orgId = gate.user.orgId;
    const visible = await db.execute(
      sql`
      select 1 from parties where id = ${id} and org_id = ${orgId}${crmSharedScope(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}`,
      "objects",
    );
    if (!visible.length) return notFound("record");
    const [account, statuses, owners, territories, sources] = await Promise.all([
      loadCrmAccount(id, orgId, gate.allowedSubsidiaryIds),
      db.execute<{ id: string; name: string; lifecycle_stage: string; is_default: boolean }>(
        sql`
        select id, name, lifecycle_stage, is_default from crm_account_statuses
         where org_id = ${orgId} and is_active order by lifecycle_stage, sequence, name`,
        "objects",
      ),
      db.execute<{ id: string; name: string }>(
        sql`select id, name from users where org_id = ${orgId} and is_active order by name`,
        "objects",
      ),
      db.execute<{ id: string; name: string }>(
        sql`select id, name from crm_sales_territories where org_id = ${orgId} and is_active order by priority, name`,
        "objects",
      ),
      db.execute<{ id: string; name: string }>(
        sql`select id, name from crm_lead_sources where org_id = ${orgId} and is_active order by name`,
        "objects",
      ),
    ]);
    return NextResponse.json({
      account,
      options: {
        statuses,
        owners,
        territories,
        sources,
      },
    });
  },
});

/**
 * Start tracking an existing party as a relationship.
 *
 * Customers minted by the AR side (or by an import) carry a customer role and
 * no crm_account_profiles row, so PATCH has nothing to update. This opens the
 * profile at the stage the party already IS — `customer` when it holds an
 * active customer role, `lead` otherwise — and records the stage event, so
 * the lifecycle history starts honest instead of claiming a conversion that
 * never happened. It is deliberately idempotent-ish: an existing profile wins.
 */
export const POST = defineRoute({
  permission: "crm.accounts.manage",
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => {
    const result = await startCrmAccountTracking(authz, params.id);
    if ("response" in result) return result.response;
    return NextResponse.json(result.body, { status: result.status });
  },
});

export const PATCH = defineRoute({
  permission: "crm.accounts.manage",
  feature: "crm",
  params: z.object({ id: z.string() }),
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    patchCrmAccount(authz, params.id, body as Record<string, unknown>),
});
