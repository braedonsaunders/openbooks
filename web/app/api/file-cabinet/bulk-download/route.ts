import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import {
  buildZip,
  filesZipManifest,
  MAX_ZIP_FILES,
  ZipSizeLimitError,
} from "../../../../lib/file-zip";
import { fileViewer } from "../lib";
const postBodySchema0 = z.strictObject({
  fileIds: z.array(z.string().uuid("fileIds must contain valid ids")).min(1, "select at least one file"),
});

export const runtime = "nodejs";

/** Zip a set of selected files. Per-file visibility is enforced while building
 *  (unreadable files are skipped). Body: { fileIds: string[] }. */
export const POST = defineRoute({
  permission: "documents.read",
  feature: {
    none: "This documents surface is governed by its permission and has no separate organization feature switch.",
  },
  body: postBodySchema0,
  handler: async ({ authz: gate, body }) => {
    const fileIds = body.fileIds;
    if (fileIds.length > MAX_ZIP_FILES) {
      return NextResponse.json(
        { error: `too many files (limit ${MAX_ZIP_FILES})` },
        { status: 413 },
      );
    }

    const viewer = fileViewer(gate);
    const entries = await filesZipManifest(gate.user.orgId, fileIds, viewer);
    let bytes: Buffer;
    let included: number;
    try {
      ({ bytes, included } = await buildZip(gate.user.orgId, viewer, entries));
    } catch (error) {
      if (error instanceof ZipSizeLimitError) {
        return apiErrorResponse(error, { safeStatus: 413 });
      }
      throw error;
    }
    if (included === 0)
      return NextResponse.json(
        { error: "nothing to download" },
        { status: 404 },
      );

    const stamp = await businessToday(gate.user.orgId);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="files-${stamp}.zip"`,
        "Cache-Control": "private, no-store",
      },
    });
  },
});
