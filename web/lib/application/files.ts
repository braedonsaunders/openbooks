import "server-only";
import { can, type Authz } from "../authz";
import {
  accessAtLeast,
  createFile,
  folderAccessLevel,
  getFile,
  getFolder,
  getFolderTree,
  listFiles,
  type AccessLevel,
  type FileViewer,
} from "../file-cabinet";
import { clamp, isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { forbidden, invalidInput, notFound } from "./errors";

/**
 * File Cabinet upload behind the `upload_file` application tool. Same
 * storage path (`createFile`) and same folder grant gate (Editor+) as
 * POST /api/file-cabinet/files — the tool is a second transport over that
 * route's service, never a parallel writer.
 */

/**
 * Content types the cabinet stores. Mirror of ALLOWED_CONTENT_TYPES in
 * web/app/api/file-cabinet/lib.ts (lib code must not import from app/api,
 * so the list is copied — keep in sync).
 */
const ALLOWED_CONTENT_TYPES: Record<string, true> = {
  "application/pdf": true,
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "text/csv": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "text/plain": true,
  "text/markdown": true,
  "text/javascript": true,
  "application/json": true,
  "application/xml": true,
  "text/xml": true,
};

export function isUploadContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES[contentType.split(";")[0]!.trim().toLowerCase()] === true;
}

/** Tool payloads stay model-sized: 1 MB of bytes (the route allows 25 MB). */
export const MAX_UPLOAD_BYTES = 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/=]+$/;

export type CabinetUpload = { filename: string; contentType: string; bytes: Buffer };

/** Pure input validation: filename, allowlisted content type, base64 size. */
export function validateCabinetUpload(input: {
  filename: string;
  contentType: string;
  contentBase64: string;
}): CabinetUpload {
  const filename = input.filename.trim();
  if (!filename) throw invalidInput("filename is required");
  if (filename.length > 255) throw invalidInput("filename exceeds 255 characters");
  const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
  if (!isUploadContentType(contentType)) throw invalidInput(`unsupported file type: ${input.contentType || "unknown"}`);
  const compact = input.contentBase64.replace(/\s+/g, "");
  if (!compact) throw invalidInput("file is empty");
  if (!BASE64.test(compact)) throw invalidInput("contentBase64 is not valid base64");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0) throw invalidInput("file is empty");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw invalidInput(`file exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB tool upload limit`);
  }
  return { filename, contentType, bytes };
}

/** File Cabinet metadata — same `listFiles` reader and folder grants as the files screen. */
export async function listApplicationFiles(
  context: ApplicationContext,
  input: { folderId?: string; query?: string; limit?: number; offset?: number },
) {
  assertApplicationPermission(context, "documents.read");
  if (input.folderId && !isUuid(input.folderId)) throw invalidInput("folderId must be a UUID");
  const limit = clamp(input.limit ?? 25, 1, 100);
  const offset = clamp(input.offset ?? 0, 0, 10_000);
  const { files, total } = await listFiles(context.authz.user.orgId, cabinetViewer(context.authz), {
    folderId: input.folderId,
    q: input.query,
    limit,
    offset,
  });
  return {
    total,
    offset,
    files: files.map((file) => ({
      id: file.id,
      name: file.name,
      folderId: file.folderId,
      folderName: file.folderName,
      fileType: file.fileType,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      versionCount: file.versionCount,
      updatedAt: file.updatedAt,
      uploadedBy: file.createdBy,
      createdAt: file.createdAt,
    })),
  };
}

/** One file's metadata — same `getFile` reader as the files screen. Never contents. */
export async function getApplicationFile(context: ApplicationContext, fileId: string) {
  assertApplicationPermission(context, "documents.read");
  if (!isUuid(fileId)) throw invalidInput("file id must be a UUID");
  const file = await getFile(context.authz.user.orgId, fileId, cabinetViewer(context.authz));
  if (!file) throw notFound("file");
  return {
    id: file.id,
    name: file.name,
    extension: file.extension,
    folderId: file.folderId,
    folderName: file.folderName,
    fileType: file.fileType,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    isInactive: file.isInactive,
    versionCount: file.versionCount,
    createdAt: file.createdAt,
    uploadedBy: file.createdBy,
    updatedAt: file.updatedAt,
    updatedBy: file.updatedBy,
    versions: file.versions.map((version) => ({
      versionNumber: version.versionNumber,
      sizeBytes: version.sizeBytes,
      contentType: version.contentType,
      createdAt: version.createdAt,
      createdBy: version.createdBy,
    })),
    attachments: file.attachments.map((attachment) => ({
      targetTable: attachment.targetTable,
      targetId: attachment.targetId,
      attachedAt: attachment.createdAt,
    })),
  };
}

/** Visible folders — same `getFolderTree` reader as the files screen. */
export async function listApplicationFolders(context: ApplicationContext) {
  assertApplicationPermission(context, "documents.read");
  const folders = await getFolderTree(context.authz.user.orgId, cabinetViewer(context.authz));
  return {
    total: folders.length,
    folders: folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      isSystem: folder.isSystem,
      systemKind: folder.systemKind,
      isPrivate: folder.isPrivate,
      childCount: folder.childCount,
      fileCount: folder.fileCount,
    })),
  };
}

/**
 * The caller as a FileViewer. Faithful replica of `fileViewer(authz)` in
 * web/app/api/file-cabinet/lib.ts (same precedent as assistantFileViewer in
 * web/lib/assistant/tools-files.ts — keep in sync).
 */
function cabinetViewer(authz: Authz): FileViewer {
  const baseline: AccessLevel = can(authz, "documents.manage")
    ? "manager"
    : can(authz, "documents.read")
      ? "viewer"
      : "none";
  return { userId: authz.user.id, isAdmin: can(authz, "*"), baseline, allowedSubsidiaryIds: authz.allowedSubsidiaryIds };
}

export async function uploadCabinetFile(
  authz: Authz,
  input: { folderId: string; filename: string; contentType: string; contentBase64: string },
): Promise<{ id: string; name: string; folderId: string; folderName: string | null; contentType: string; sizeBytes: number }> {
  const { filename, contentType, bytes } = validateCabinetUpload(input);
  const folder = await getFolder(authz.user.orgId, input.folderId);
  if (!folder) throw notFound("folder");
  // Uploading needs Editor+ on the destination folder — the route's gate.
  const level = await folderAccessLevel(authz.user.orgId, cabinetViewer(authz), input.folderId);
  if (!accessAtLeast(level, "editor")) throw forbidden("documents.manage");
  const meta = await createFile({
    orgId: authz.user.orgId,
    folderId: input.folderId,
    filename,
    contentType,
    bytes,
    createdBy: authz.user.id,
    audit: { actorId: authz.user.id },
  });
  return {
    id: meta.id,
    name: meta.name,
    folderId: meta.folderId,
    folderName: meta.folderName,
    contentType: meta.contentType,
    sizeBytes: meta.sizeBytes,
  };
}
