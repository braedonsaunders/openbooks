import "server-only";
import { z } from "zod";
import { can, type Authz } from "../authz";
import {
  getFile,
  getFolderTree,
  listFiles,
  type AccessLevel,
  type FileViewer,
} from "../file-cabinet";
import type { AssistantToolDef, ToolResult } from "./types";
import { capList, uuidInput } from "./tools-shared";

/**
 * Read/search tools for the File Cabinet (the /documents page). Every query
 * goes through web/lib/file-cabinet.ts with a FileViewer, so private folders,
 * resource grants, and org scoping are enforced exactly as they are for the
 * UI and the /api/file-cabinet routes. Metadata only — never blob content.
 */

/**
 * The caller as a FileViewer for access control. Faithful replica of
 * `fileViewer(authz)` in web/app/api/file-cabinet/lib.ts (lib code must not
 * import from app/api, so the 3-line rule is mirrored here — keep in sync):
 * `*` admins get Manager everywhere; otherwise the org-role baseline is
 * Manager for documents.manage, Viewer for documents.read. resource_grants
 * layer on top per folder/file inside the query layer.
 */
function assistantFileViewer(authz: Authz): FileViewer {
  const baseline: AccessLevel = can(authz, "documents.manage")
    ? "manager"
    : can(authz, "documents.read")
      ? "viewer"
      : "none";
  return { userId: authz.user.id, isAdmin: can(authz, "*"), baseline };
}

const listFilesTool: AssistantToolDef = {
  name: "list_files",
  description:
    "Search the File Cabinet: file metadata (name, folder, size, content type, uploader, updated date) optionally filtered by folder and/or a name search, paginated. Respects the user's folder/file access grants. Never returns file contents. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["documents.read"] },
  inputSchema: z.object({
    folderId: uuidInput.optional(),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { folderId?: string; query?: string; limit?: number; offset?: number };
    const limit = Math.min(a.limit ?? 25, 100);
    const offset = a.offset ?? 0;
    const { files, total } = await listFiles(authz.user.orgId, assistantFileViewer(authz), {
      folderId: a.folderId,
      q: a.query,
      limit,
      offset,
    });
    return {
      ok: true,
      data: {
        total,
        returned: files.length,
        offset,
        truncated: offset + files.length < total,
        href: "/documents",
        items: files.map((f) => ({
          id: f.id,
          name: f.name,
          folderId: f.folderId,
          folderName: f.folderName,
          fileType: f.fileType,
          contentType: f.contentType,
          sizeBytes: f.sizeBytes,
          versionCount: f.versionCount,
          updatedAt: f.updatedAt,
          uploadedBy: f.createdBy,
          createdAt: f.createdAt,
        })),
      },
    };
  },
};

const getFileTool: AssistantToolDef = {
  name: "get_file",
  description:
    "One File Cabinet file's metadata detail: name, folder, size, content type, version history summary, and which records it is attached to. Respects access grants (a file the user cannot see reads as not found). Never returns file contents. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["documents.read"] },
  inputSchema: z.object({ id: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { id: string };
    const f = await getFile(authz.user.orgId, a.id, assistantFileViewer(authz));
    if (!f) return { ok: false, error: "file_not_found" };
    const attachments = capList(
      f.attachments.map((att) => ({
        targetTable: att.targetTable,
        targetId: att.targetId,
        attachedAt: att.createdAt,
      })),
      50,
    );
    const versions = capList(
      f.versions.map((v) => ({
        versionNumber: v.versionNumber,
        sizeBytes: v.sizeBytes,
        contentType: v.contentType,
        createdAt: v.createdAt,
        createdBy: v.createdBy,
      })),
      20,
    );
    return {
      ok: true,
      data: {
        id: f.id,
        name: f.name,
        extension: f.extension,
        folderId: f.folderId,
        folderName: f.folderName,
        fileType: f.fileType,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        isInactive: f.isInactive,
        versionCount: f.versionCount,
        createdAt: f.createdAt,
        uploadedBy: f.createdBy,
        updatedAt: f.updatedAt,
        updatedBy: f.updatedBy,
        // Same deep link the file list renders (see /documents FileList.tsx).
        href: `/documents?file=${f.id}`,
        versions: versions.items,
        versionsTruncated: versions.truncated,
        attachments: attachments.items,
        attachmentsTruncated: attachments.truncated,
      },
    };
  },
};

const listFoldersTool: AssistantToolDef = {
  name: "list_folders",
  description:
    "The File Cabinet folder tree the user may see (flat list with parent links): folder id, name, parent, system kind, and sub-folder/file counts. Private folders owned by others are excluded unless shared with the user. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["documents.read"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const folders = await getFolderTree(authz.user.orgId, assistantFileViewer(authz));
    const { items, truncated } = capList(
      folders.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        isSystem: f.isSystem,
        systemKind: f.systemKind,
        isPrivate: f.isPrivate,
        childCount: f.childCount,
        fileCount: f.fileCount,
      })),
    );
    return {
      ok: true,
      data: { total: folders.length, truncated, href: "/documents", items },
    };
  },
};

export const FILE_TOOLS: AssistantToolDef[] = [listFilesTool, getFileTool, listFoldersTool];
