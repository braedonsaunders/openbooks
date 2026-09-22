import { NextResponse } from "next/server";
import { readV1JsonObject, requireV1IdempotencyKey, withV1Request } from "../../../../../../lib/api/v1-request";
import { assertApplicationPermission } from "../../../../../../lib/application/context";
import { executeIdempotent } from "../../../../../../lib/application/idempotency";
import { getSetupRecord } from "../../../../../../lib/application/setup-read";
import { settleWrite } from "../../../../../../lib/application/tool-catalog";
import { deleteSetupRecord, updateSetupRecord } from "../../../../../../lib/setup/write";

export const runtime = "nodejs";

/**
 * GET /api/v1/setup/[entityKey]/[id] — one Setup record by primary key.
 * Looks up the row by id; never scans a paged list.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ entityKey: string; id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/setup/:entityKey/:id", async (_auth, context) => {
    const { entityKey, id } = await params;
    return { status: 200, body: await getSetupRecord(context, { entityKey, id }) };
  });
}

/**
 * PATCH /api/v1/setup/[entityKey]/[id] — update one Setup-entity record.
 * Same command as the `update_setup_record` application tool; the row id
 * comes from the path and is merged into the body the writer validates.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ entityKey: string; id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/setup/:entityKey/:id", async (_auth, context) => {
    assertApplicationPermission(context, "admin.setup.manage");
    const { entityKey, id } = await params;
    const raw = await readV1JsonObject(request);
    const body = { ...raw, id };
    const outcome = await executeIdempotent({
      context,
      operation: "setup_record.update",
      idempotencyKey: requireV1IdempotencyKey(request),
      request: { entityKey, body },
      execute: async () => settleWrite(await updateSetupRecord(
        { orgId: context.authz.user.orgId, id: context.authz.user.id, permissions: context.authz.permissions },
        entityKey,
        body,
      )),
    });
    return { status: 200, body: outcome.value, replayed: outcome.replayed };
  });
}

/**
 * DELETE /api/v1/setup/[entityKey]/[id] — delete (or archive, where the
 * entity keeps history) one configuration record. Refusals for records
 * referenced by postings come from `deleteSetupRecord` itself.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ entityKey: string; id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/setup/:entityKey/:id", async (_auth, context) => {
    assertApplicationPermission(context, "admin.setup.manage");
    const { entityKey, id } = await params;
    const outcome = await executeIdempotent({
      context,
      operation: "setup_record.delete",
      idempotencyKey: requireV1IdempotencyKey(request),
      request: { entityKey, id },
      execute: async () => settleWrite(await deleteSetupRecord(
        { orgId: context.authz.user.orgId, id: context.authz.user.id, permissions: context.authz.permissions },
        entityKey,
        id,
      )),
    });
    return { status: 200, body: outcome.value, replayed: outcome.replayed };
  });
}
