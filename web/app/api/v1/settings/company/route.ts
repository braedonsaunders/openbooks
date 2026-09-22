import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../lib/application/errors";
import { assertApplicationPermission } from "../../../../../lib/application/context";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { executeIdempotent } from "../../../../../lib/application/idempotency";
import { can } from "../../../../../lib/authz";
import { readCompanySettings, updateCompanySettings } from "../../../../../lib/company-settings";

export const runtime = "nodejs";

function settle(result: { status: number; body: Record<string, unknown> }): Record<string, unknown> {
  if (result.status < 300) return result.body;
  const message = typeof result.body.message === "string"
    ? result.body.message
    : typeof result.body.error === "string" ? result.body.error : "request refused";
  if (result.status === 403) throw new ApplicationError("forbidden", "forbidden", 403, result.body);
  if (result.status === 404) throw new ApplicationError("not_found", message, 404, result.body);
  if (result.status === 409) throw new ApplicationError("conflict", message, 409, result.body);
  throw new ApplicationError("invalid_input", message, 422, result.body);
}

/** GET /api/v1/settings/company */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/settings/company", async (_auth, context) => {
    if (!can(context.authz, "admin.users.manage") && !can(context.authz, "admin.setup.manage")) {
      throw new ApplicationError("forbidden", "forbidden", 403);
    }
    return { status: 200, body: settle(await readCompanySettings(context.authz.user.orgId)) };
  });
}

/** PATCH /api/v1/settings/company */
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
      execute: async () => settle(await updateCompanySettings(context.authz.user, changes)),
    });
    return { status: 200, body: outcome.value, replayed: outcome.replayed };
  });
}
