import { inDbTransaction } from "@openbooks/engine/platform/db";
import {
  accessAtLeast,
  deleteFile,
  deleteFolder,
  fileAccessLevel,
  folderAccessLevel,
  isRetainedFileEvidence,
  moveFile,
  moveFolder,
  type AccessLevel,
  type FileViewer,
} from "./index";

export type BulkItemResult = {
  id: string;
  kind: "file" | "folder";
  ok: boolean;
  error?: string;
};

export type BulkCabinetActionInput = {
  orgId: string;
  actorId: string;
  viewer: FileViewer;
  action: "delete" | "move";
  fileIds: string[];
  folderIds: string[];
  targetFolderId?: string;
};

export type BulkCabinetActionResult = {
  done: number;
  skipped: number;
  results: BulkItemResult[];
};

function requiredAccess(action: "delete" | "move", kind: "file" | "folder"): AccessLevel {
  if (action === "move") return kind === "folder" ? "manager" : "editor";
  return "manager";
}

/** Apply the File Cabinet's per-item bulk policy in one transaction. */
export async function applyBulkCabinetAction(
  input: BulkCabinetActionInput,
): Promise<BulkCabinetActionResult> {
  const { orgId, actorId, viewer, action, fileIds, folderIds, targetFolderId } = input;
  return inDbTransaction(async (tx) => {
    let done = 0;
    let skipped = 0;
    const results: BulkItemResult[] = [];
    const audit = { actorId, executor: tx, viewer };
    const record = (id: string, kind: "file" | "folder", ok: boolean, error?: string) => {
      if (ok) done++;
      else skipped++;
      results.push(error ? { id, kind, ok, error } : { id, kind, ok });
    };

    if (action === "move") {
      if (!targetFolderId) throw new Error("move requires a destination folder");
      for (const id of fileIds) {
        if (
          !accessAtLeast(await fileAccessLevel(orgId, viewer, id), requiredAccess(action, "file"))
        ) {
          record(id, "file", false, "forbidden");
          continue;
        }
        if (await moveFile(orgId, id, targetFolderId, actorId, audit)) record(id, "file", true);
        else record(id, "file", false, "failed");
      }
      for (const id of folderIds) {
        if (
          !accessAtLeast(
            await folderAccessLevel(orgId, viewer, id),
            requiredAccess(action, "folder"),
          )
        ) {
          record(id, "folder", false, "forbidden");
          continue;
        }
        if (await moveFolder(orgId, id, targetFolderId, actorId, audit)) record(id, "folder", true);
        else record(id, "folder", false, "failed");
      }
    } else {
      for (const id of fileIds) {
        if (
          !accessAtLeast(await fileAccessLevel(orgId, viewer, id), requiredAccess(action, "file"))
        ) {
          record(id, "file", false, "forbidden");
          continue;
        }
        if (await deleteFile(orgId, id, audit)) record(id, "file", true);
        else if (await isRetainedFileEvidence(orgId, id)) record(id, "file", false, "retained");
        else record(id, "file", false, "failed");
      }
      for (const id of folderIds) {
        if (
          !accessAtLeast(
            await folderAccessLevel(orgId, viewer, id),
            requiredAccess(action, "folder"),
          )
        ) {
          record(id, "folder", false, "forbidden");
          continue;
        }
        const result = await deleteFolder(orgId, id, audit);
        if (result.ok) record(id, "folder", true);
        else
          record(
            id,
            "folder",
            false,
            result.reason === "not found" ? "not_found" : (result.reason ?? "failed"),
          );
      }
    }

    return { done, skipped, results };
  });
}

export async function canMoveCabinetTarget(
  orgId: string,
  viewer: FileViewer,
  targetFolderId: string,
): Promise<boolean> {
  return accessAtLeast(await folderAccessLevel(orgId, viewer, targetFolderId), "editor");
}
