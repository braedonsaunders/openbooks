import { NextResponse } from "next/server";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../lib/api/v1-request";
import { uploadCabinetFile } from "../../../../lib/application/files";
import { executeIdempotent } from "../../../../lib/application/idempotency";

export const runtime = "nodejs";

/** POST /api/v1/files — File Cabinet upload through the same storage and grants. */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/files", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    const folderId = String(body.folderId ?? "");
    const filename = String(body.filename ?? "");
    const contentType = String(body.contentType ?? "");
    const contentBase64 = String(body.contentBase64 ?? "");
    const outcome = await executeIdempotent({
      context,
      operation: "file.upload",
      idempotencyKey: requireV1IdempotencyKey(request),
      request: { folderId, filename, contentType },
      execute: async () => uploadCabinetFile(context.authz, {
        folderId, filename, contentType, contentBase64,
      }),
    });
    return { status: 201, body: outcome.value, replayed: outcome.replayed };
  });
}
