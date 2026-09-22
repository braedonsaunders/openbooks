import { NextResponse } from "next/server";
import { readV1JsonObject, requireV1IdempotencyKey, withV1Request } from "../../../../../lib/api/v1-request";
import { assertApplicationPermission } from "../../../../../lib/application/context";
import { executeIdempotent } from "../../../../../lib/application/idempotency";
import { listSetupRecords } from "../../../../../lib/application/setup-read";
import { settleWrite } from "../../../../../lib/application/tool-catalog";
import { createSetupRecord } from "../../../../../lib/setup/write";

export const runtime = "nodejs";

/**
 * GET /api/v1/setup/[entityKey] — records of one Setup entity.
 * Same registry-driven select as `list_setup_records` and /admin/setup.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ entityKey: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/setup/:entityKey", async (_auth, context) => {
    const { entityKey } = await params;
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listSetupRecords(context, {
        entityKey,
        query: url.searchParams.get("q")?.trim() || undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}

/**
 * POST /api/v1/setup/[entityKey] — create one Setup-entity record.
 * Same command as the `create_setup_record` application tool: column
 * whitelisting, validation, the feature fence, per-entity rules, and audit
 * evidence all live in `createSetupRecord`, not here.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ entityKey: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/setup/:entityKey", async (_auth, context) => {
    assertApplicationPermission(context, "admin.setup.manage");
    const { entityKey } = await params;
    const body = await readV1JsonObject(request);
    const outcome = await executeIdempotent({
      context,
      operation: "setup_record.create",
      idempotencyKey: requireV1IdempotencyKey(request),
      request: { entityKey, body },
      execute: async () => settleWrite(await createSetupRecord(
        { orgId: context.authz.user.orgId, id: context.authz.user.id, permissions: context.authz.permissions },
        entityKey,
        body,
      )),
    });
    return { status: 200, body: outcome.value, replayed: outcome.replayed };
  });
}
