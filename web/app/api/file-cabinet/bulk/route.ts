import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { applyBulkCabinetAction, canMoveCabinetTarget } from "@/lib/file-cabinet/bulk-actions";
import { fileViewer } from "../lib";
const itemIds = z.array(uuidString("selection ids must be valid UUIDs")).max(500).default([]);
const postBodySchema = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("delete"), fileIds: itemIds, folderIds: itemIds }),
    z.strictObject({
      action: z.literal("move"),
      fileIds: itemIds,
      folderIds: itemIds,
      targetFolderId: uuidString("targetFolderId must be a valid id"),
    }),
  ])
  .refine(
    (body) => body.fileIds.length > 0 || body.folderIds.length > 0,
    "select at least one file or folder",
  );

export const runtime = "nodejs";

/**
 * Bulk file/folder actions. Body:
 *   { action: 'delete' | 'move', fileIds?, folderIds?, targetFolderId? }
 * Access is checked per item (unauthorized items are skipped, not fatal); the
 * response reports how many succeeded AND the verdict per requested id, so
 * the caller can keep exactly the refused rows selected instead of reporting
 * a partial bulk as full success.
 */
export const POST = defineRoute({
  public: "session",
  body: postBodySchema,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    const orgId = gate.user.orgId;
    const viewer = fileViewer(gate);

    const { action, fileIds, folderIds } = routeBody;
    const targetFolderId = routeBody.action === "move" ? routeBody.targetFolderId : null;
    if (targetFolderId !== null && !(await canMoveCabinetTarget(orgId, viewer, targetFolderId))) {
      // Destination needs Editor+.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const result = await applyBulkCabinetAction({
      orgId,
      actorId: gate.user.id,
      viewer,
      action,
      fileIds,
      folderIds,
      ...(targetFolderId ? { targetFolderId } : {}),
    });

    return NextResponse.json({ ok: true, ...result });
  },
});
