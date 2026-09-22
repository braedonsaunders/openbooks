import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../lib/application/errors";
import { assertApplicationPermission } from "../../../../../lib/application/context";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { executeIdempotent } from "../../../../../lib/application/idempotency";
import { settleWrite } from "../../../../../lib/application/tool-catalog";
import { can } from "../../../../../lib/authz";
import { readCompanySettings, updateCompanySettings } from "../../../../../lib/company-settings";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/company — the Company & Accounting settings view.
 * Reads keep the user-administration view gate (the same two permissions the
 * `get_company_settings` tool is visible to); refusals settle through the
 * shared settings/setup write mapping, never as silent nulls.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/settings/company", async (_auth, context) => {
    if (!can(context.authz, "admin.users.manage") && !can(context.authz, "admin.setup.manage")) {
      throw new ApplicationError("forbidden", "forbidden", 403);
    }
    return { status: 200, body: settleWrite(await readCompanySettings(context.authz.user.orgId)) };
  });
}

/**
 * PATCH /api/v1/settings/company — change Company & Accounting settings
 * (only the keys passed change). Same command as the `update_company_settings`
 * application tool, so the fiscal-calendar and base-currency immutability
 * rules, control-account checks, and audit evidence are shared, not copied.
 */
export async function PATCH(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/settings/company", async (_auth, context) => {
    assertApplicationPermission(context, "admin.setup.manage");
    const body = await readV1JsonObject(request);
    const raw = (body.changes && typeof body.changes === "object" && !Array.isArray(body.changes)
      ? body.changes
      : body) as Record<string, unknown>;
    const changes = { ...raw };
    delete changes.idempotencyKey;
    if (Object.keys(changes).length === 0) {
      throw new ApplicationError("invalid_input", "changes must name at least one setting", 422);
    }
    const outcome = await executeIdempotent({
      context,
      operation: "company_settings.update",
      idempotencyKey: requireV1IdempotencyKey(request),
      request: { changes },
      execute: async () => settleWrite(await updateCompanySettings(
        { orgId: context.authz.user.orgId, id: context.authz.user.id },
        changes,
      )),
    });
    return { status: 200, body: outcome.value, replayed: outcome.replayed };
  });
}
