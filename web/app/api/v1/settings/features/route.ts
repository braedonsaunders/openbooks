import { NextResponse } from "next/server";
import { ApplicationError, conflict, notFound } from "../../../../../lib/application/errors";
import { assertApplicationPermission } from "../../../../../lib/application/context";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../lib/api/v1-request";
import { executeIdempotent } from "../../../../../lib/application/idempotency";
import { applyFeatureChanges, normalizeFeatureChanges } from "../../../../../lib/features-admin";
import { listApplicationFeatures } from "../../../../../lib/application/setup-read";

export const runtime = "nodejs";

/** GET /api/v1/settings/features — the Features switchboard as this org sees it. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/settings/features", async (_auth, context) => ({
    status: 200,
    body: await listApplicationFeatures(context),
  }));
}

/**
 * POST /api/v1/settings/features — the Features switchboard write.
 * Same command as the `update_features` application tool (and the Features
 * page): dependencies enforced, load-bearing modules cannot disable, enabling
 * installs baseline config. The feature gate stays in that command — this
 * route adds no second gate.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/settings/features", async (_auth, context) => {
    assertApplicationPermission(context, "admin.setup.manage");
    const body = await readV1JsonObject(request);
    const normalized = normalizeFeatureChanges(body.features ?? body);
    if (!normalized.ok) {
      throw new ApplicationError(
        "invalid_input",
        normalized.error,
        422,
        normalized.key ? { key: normalized.key } : undefined,
      );
    }
    const outcome = await executeIdempotent({
      context,
      operation: "features.update",
      idempotencyKey: requireV1IdempotencyKey(request),
      request: { features: normalized.changes },
      execute: async () => {
        const result = await applyFeatureChanges(
          context.authz.user.orgId,
          context.authz.user.id,
          normalized.changes,
        );
        if (!result.ok) {
          if (result.error === "not-found") throw notFound("organization");
          const details: Record<string, unknown> = { ...result };
          delete details.ok;
          delete details.error;
          throw conflict(result.error, details);
        }
        return { before: result.before, after: result.after };
      },
    });
    return { status: 200, body: outcome.value, replayed: outcome.replayed };
  });
}
