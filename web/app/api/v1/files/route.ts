import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../lib/api/v1-request";
import { listApplicationFiles, uploadCabinetFile } from "../../../../lib/application/files";
import { executeIdempotent } from "../../../../lib/application/idempotency";
import { withContentDigest } from "../../../../lib/application/idempotency-core";

const uploadFileBody = z.looseObject({
  folderId: z.string().min(1),
  filename: z.string().trim().min(1),
  contentType: z.string().trim().min(1),
  contentBase64: z.string().min(1),
});

export const runtime = "nodejs";

/** GET /api/v1/files — File Cabinet metadata through the same grants as the files screen. */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/files", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const offsetRaw = url.searchParams.get("offset");
    return {
      status: 200,
      body: await listApplicationFiles(context, {
        folderId: url.searchParams.get("folderId") ?? undefined,
        query: url.searchParams.get("q") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
        offset: offsetRaw ? Number(offsetRaw) : undefined,
      }),
    };
  });
}

/** POST /api/v1/files — File Cabinet upload through the same storage and grants. */
async function handleV1POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/files", async (_auth, context) => {
    const body = uploadFileBody.parse(await readV1JsonObject(request));
    const folderId = body.folderId;
    const filename = body.filename;
    const contentType = body.contentType;
    const contentBase64 = body.contentBase64;
    const outcome = await executeIdempotent({
      context,
      operation: "file.upload",
      idempotencyKey: requireV1IdempotencyKey(request),
      request: withContentDigest(
        { folderId, filename, contentType },
        contentBase64.replace(/\s+/g, ""),
      ),
      authorizeReplay: async () => {
        const { assertCabinetUploadAccess } = await import("../../../../lib/application/files");
        await assertCabinetUploadAccess(context.authz, folderId);
      },
      execute: async () => uploadCabinetFile(context.authz, {
        folderId, filename, contentType, contentBase64,
      }),
    });
    return { status: 201, body: outcome.value, replayed: outcome.replayed };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
