import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  accessAtLeast,
  deleteFile,
  deleteFolder,
  fileAccessLevel,
  folderAccessLevel,
  isRetainedFileEvidence,
  moveFile,
  moveFolder,
} from "../../../../lib/file-cabinet";
import { inDbTransaction } from "@openbooks/engine/src/platform/db.ts";
import { isUuid } from "../../../../lib/list-params";
import { fileViewer } from "../lib";
const itemIds = z.array(z.string().uuid("selection ids must be valid UUIDs")).max(500).default([]);
const postBodySchema0 = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("delete"), fileIds: itemIds, folderIds: itemIds }),
  z.strictObject({
    action: z.literal("move"),
    fileIds: itemIds,
    folderIds: itemIds,
    targetFolderId: z.string().uuid("targetFolderId must be a valid id"),
  }),
]).refine(
  (body) => body.fileIds.length > 0 || body.folderIds.length > 0,
  "select at least one file or folder",
);

export { runtime } from "@/lib/api/route";

function idList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && isUuid(x))
    : [];
}

type BulkItemResult = {
  id: string;
  kind: "file" | "folder";
  ok: boolean;
  error?: string;
};

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
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    const orgId = gate.user.orgId;
    const viewer = fileViewer(gate);

    const body = routeBody as Record<string, unknown> | null;
    const action = body?.action;
    const fileIds = idList(body?.fileIds);
    const folderIds = idList(body?.folderIds);
    if (action !== "delete" && action !== "move") {
      return NextResponse.json(
        { error: "action must be delete or move" },
        { status: 400 },
      );
    }
    if (fileIds.length === 0 && folderIds.length === 0) {
      return NextResponse.json({ error: "nothing selected" }, { status: 400 });
    }

    let targetFolderId: string | null = null;
    if (action === "move") {
      const candidate = body?.targetFolderId;
      if (typeof candidate !== "string" || !isUuid(candidate)) {
        return NextResponse.json(
          { error: "valid targetFolderId is required" },
          { status: 400 },
        );
      }
      targetFolderId = candidate;
      // Destination needs Editor+.
      if (
        !accessAtLeast(
          await folderAccessLevel(orgId, viewer, targetFolderId),
          "editor",
        )
      ) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }

    const result = await inDbTransaction(async (tx) => {
      let done = 0;
      let skipped = 0;
      const results: BulkItemResult[] = [];
      const audit = { actorId: gate.user.id, executor: tx, viewer };
      const record = (
        id: string,
        kind: "file" | "folder",
        ok: boolean,
        error?: string,
      ) => {
        if (ok) done++;
        else skipped++;
        results.push(error ? { id, kind, ok, error } : { id, kind, ok });
      };

      if (action === "move") {
        for (const id of fileIds) {
          if (
            !accessAtLeast(await fileAccessLevel(orgId, viewer, id), "editor")
          ) {
            record(id, "file", false, "forbidden");
            continue;
          }
          if (await moveFile(orgId, id, targetFolderId!, gate.user.id, audit))
            record(id, "file", true);
          else record(id, "file", false, "failed");
        }
        for (const id of folderIds) {
          if (
            !accessAtLeast(
              await folderAccessLevel(orgId, viewer, id),
              "manager",
            )
          ) {
            record(id, "folder", false, "forbidden");
            continue;
          }
          if (await moveFolder(orgId, id, targetFolderId!, gate.user.id, audit))
            record(id, "folder", true);
          else record(id, "folder", false, "failed");
        }
      } else {
        // delete → trash
        for (const id of fileIds) {
          if (
            !accessAtLeast(await fileAccessLevel(orgId, viewer, id), "manager")
          ) {
            record(id, "file", false, "forbidden");
            continue;
          }
          if (await deleteFile(orgId, id, audit)) record(id, "file", true);
          else if (await isRetainedFileEvidence(orgId, id))
            record(id, "file", false, "retained");
          else record(id, "file", false, "failed");
        }
        for (const id of folderIds) {
          if (
            !accessAtLeast(
              await folderAccessLevel(orgId, viewer, id),
              "manager",
            )
          ) {
            record(id, "folder", false, "forbidden");
            continue;
          }
          const res = await deleteFolder(orgId, id, audit);
          if (res.ok) record(id, "folder", true);
          else
            record(
              id,
              "folder",
              false,
              res.reason === "not found"
                ? "not_found"
                : (res.reason ?? "failed"),
            );
        }
      }

      return { done, skipped, results };
    });

    return NextResponse.json({ ok: true, ...result });
  },
});
