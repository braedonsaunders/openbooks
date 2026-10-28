import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, inDbTransaction } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { applyBulkCabinetAction, canMoveCabinetTarget } from "../file-cabinet/bulk-actions";
import {
  accessAtLeast,
  attachExisting,
  cabinetResourceExists,
  createFolder,
  deleteFile,
  deleteFolder,
  detachAttachment,
  fileAccessLevel,
  folderAccessLevel,
  getFile,
  getAttachmentLink,
  getFolder,
  isRetainedFileEvidence,
  listGrants,
  moveFile,
  patchFolder,
  removeGrant,
  renameFile,
  restoreFile,
  restoreFolder,
  replaceFile,
  setGrant,
  type AccessLevel,
  type ResourceType,
} from "../file-cabinet";
import {
  AttachmentMutationRefusal,
  attachmentTargetInScope,
  canMutateAttachmentTarget,
  canReadAttachmentTarget,
  fileViewer,
  isAllowedContentType,
  isAttachableTargetTable,
  loadAttachmentTarget,
  MAX_BYTES,
  authorizeAttachmentTargetMutation,
} from "@/app/api/file-cabinet/lib";
import { cabinetViewer } from "./files";
import type { ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by a file or folder read tool.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function requireAuthenticated(context: ApplicationContext): void {
  if (!context.authz.user.id) throw forbidden("session");
}

async function requireCabinetAccess(
  context: ApplicationContext,
  kind: ResourceType,
  id: string,
  minimum: AccessLevel,
  includeInactive = false,
): Promise<void> {
  const { orgId } = context.authz.user;
  const viewer = cabinetViewer(context.authz);
  const actual =
    kind === "folder"
      ? await folderAccessLevel(orgId, viewer, id, undefined, { includeInactive })
      : await fileAccessLevel(orgId, viewer, id, undefined, { includeInactive });
  if (!accessAtLeast(actual, minimum)) throw forbidden("documents.manage");
}

function requireRootFolderManagement(context: ApplicationContext): void {
  if (!can(context.authz, "documents.manage") && !can(context.authz, "*")) {
    throw forbidden("documents.manage");
  }
}

function cabinetAudit(context: ApplicationContext) {
  return { actorId: context.authz.user.id, viewer: cabinetViewer(context.authz) };
}

async function setCabinetGrant(
  context: ApplicationContext,
  resourceType: ResourceType,
  resourceId: string,
  principalType: "user" | "role",
  principalId: string,
  access: AccessLevel,
) {
  requireAuthenticated(context);
  if (!(await cabinetResourceExists(context.authz.user.orgId, resourceType, resourceId))) {
    throw notFound(resourceType);
  }
  await requireCabinetAccess(context, resourceType, resourceId, "manager");
  const table = principalType === "user" ? sql`users` : sql`app_roles`;
  const principal = await db.execute(
    sql`select 1 from ${table} where id = ${principalId} and org_id = ${context.authz.user.orgId} limit 1`,
    "objects",
  );
  if (!principal[0]) throw notFound("sharing recipient");
  try {
    await setGrant({
      orgId: context.authz.user.orgId,
      resourceType,
      resourceId,
      principalType,
      principalId,
      access,
      actorId: context.authz.user.id,
      audit: cabinetAudit(context),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "GrantScopeRefusal") {
      throw forbidden("resource_grant.subsidiary_scope");
    }
    throw error;
  }
  return {
    ok: true,
    resourceId,
    resourceType,
    principalType,
    principalId,
    access,
    status: "granted",
    href: "/documents",
  };
}

async function listCabinetGrants(
  context: ApplicationContext,
  resourceType: ResourceType,
  resourceId: string,
) {
  requireAuthenticated(context);
  if (!(await cabinetResourceExists(context.authz.user.orgId, resourceType, resourceId))) {
    throw notFound(resourceType);
  }
  await requireCabinetAccess(context, resourceType, resourceId, "manager");
  return { grants: await listGrants(context.authz.user.orgId, resourceType, resourceId) };
}

async function revokeCabinetGrant(
  context: ApplicationContext,
  resourceType: ResourceType,
  resourceId: string,
  grantId: string,
) {
  requireAuthenticated(context);
  if (!(await cabinetResourceExists(context.authz.user.orgId, resourceType, resourceId))) {
    throw notFound(resourceType);
  }
  await requireCabinetAccess(context, resourceType, resourceId, "manager");
  const removed = await removeGrant(
    context.authz.user.orgId,
    grantId,
    resourceType,
    resourceId,
    cabinetAudit(context),
  );
  if (!removed) throw notFound("sharing grant");
  return { ok: true, resourceId, grantId, resourceType, status: "revoked", href: "/documents" };
}

const grantInput = z.object({
  resourceId: UUID,
  principalType: z.enum(["user", "role"]).describe("A user or an organization role."),
  principalId: UUID.describe("Recipient user or role id from the organization directory."),
  access: z.enum(["viewer", "editor", "manager"]).describe("Access granted on this resource."),
  idempotencyKey: IDEMPOTENCY_KEY,
});

const bulkIds = z.array(UUID).max(500).default([]);

function bulkCabinetTool(action: "move" | "delete"): ApplicationToolDefinition {
  const moving = action === "move";
  return definition({
    name: moving ? "bulk_move_file_cabinet_items" : "bulk_delete_file_cabinet_items",
    title: moving ? "Move File Cabinet Items" : "Delete File Cabinet Items",
    description: moving
      ? "Move selected files and folders together while applying the File Cabinet's per-item Editor and Manager grants. Use list_files and list_folders for ids, and verify each result there."
      : "Move selected files and folders to the File Cabinet trash while applying each item's Manager grant and retention rules. Use list_files and list_folders for ids, and review per-item refusals in the result.",
    inputSchema: z
      .object({
        fileIds: bulkIds.describe("File ids selected from the File Cabinet."),
        folderIds: bulkIds.describe("Folder ids selected from the File Cabinet."),
        ...(moving
          ? {
              targetFolderId: UUID.describe(
                "Destination folder id; the caller needs Editor access.",
              ),
            }
          : {}),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => input.fileIds.length > 0 || input.folderIds.length > 0, {
        message: "Select at least one file or folder.",
      }),
    readOnly: false,
    destructive: !moving,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      const viewer = cabinetViewer(context.authz);
      const targetFolderId = moving && "targetFolderId" in input ? input.targetFolderId : undefined;
      if (
        moving &&
        (!targetFolderId ||
          !(await canMoveCabinetTarget(context.authz.user.orgId, viewer, targetFolderId)))
      ) {
        throw forbidden("documents.manage");
      }
      const result = await applyBulkCabinetAction({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        viewer,
        action,
        fileIds: input.fileIds,
        folderIds: input.folderIds,
        ...(targetFolderId ? { targetFolderId } : {}),
      });
      return { ok: true, ...result, href: "/documents" };
    },
  });
}

function permissionlessResourceGate(authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) {
  return authz.user.id.length > 0;
}

export const WORKSPACE_FILE_TOOLS: ApplicationToolDefinition[] = [
  bulkCabinetTool("move"),
  bulkCabinetTool("delete"),
  definition({
    name: "create_folder",
    title: "Create Folder",
    description:
      "Create a File Cabinet folder. Creating a nested folder requires Editor access on its parent; creating a root folder requires documents.manage. Use list_folders to resolve the parent id.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(255).describe("Folder name."),
      parentId: UUID.nullable().optional().describe("Parent folder, or null for a root folder."),
      isPrivate: z
        .boolean()
        .optional()
        .describe("Limit visibility to the owner and explicit grants."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      const parentId = input.parentId ?? null;
      if (parentId) {
        if (!(await getFolder(context.authz.user.orgId, parentId))) throw notFound("parent folder");
        await requireCabinetAccess(context, "folder", parentId, "editor");
      } else {
        requireRootFolderManagement(context);
      }
      const id = await createFolder({
        orgId: context.authz.user.orgId,
        parentId,
        name: input.name,
        isPrivate: input.isPrivate === true,
        ownerId: input.isPrivate === true ? context.authz.user.id : undefined,
        createdBy: context.authz.user.id,
        audit: cabinetAudit(context),
      });
      const folder = await getFolder(context.authz.user.orgId, id, cabinetViewer(context.authz));
      if (!folder) throw notFound("created folder");
      return { ok: true, id, folder, status: "created", href: "/documents" };
    },
  }),
  definition({
    name: "update_folder",
    title: "Update Folder",
    description:
      "Rename, move, or change the privacy of a folder. Requires Manager access on the folder, Editor access on a destination parent, and documents.manage to move it to the root; use list_folders to verify the result.",
    inputSchema: z
      .object({
        folderId: UUID,
        name: z.string().trim().min(1).max(255).optional().describe("New folder name."),
        parentId: UUID.nullable().optional().describe("New parent folder, or null for root."),
        isPrivate: z.boolean().optional().describe("Whether the folder is private."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          input.name !== undefined || input.parentId !== undefined || input.isPrivate !== undefined,
        "provide a folder field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      await requireCabinetAccess(context, "folder", input.folderId, "manager");
      const current = await getFolder(context.authz.user.orgId, input.folderId);
      if (!current) throw notFound("folder");
      const patch: { parentId?: string | null; name?: string; isPrivate?: boolean } = {};
      if (input.parentId !== undefined && input.parentId !== current.parentId) {
        if (input.parentId) {
          if (!(await getFolder(context.authz.user.orgId, input.parentId)))
            throw notFound("parent folder");
          await requireCabinetAccess(context, "folder", input.parentId, "editor");
        } else {
          requireRootFolderManagement(context);
        }
        patch.parentId = input.parentId;
      }
      if (input.name !== undefined) patch.name = input.name;
      if (input.isPrivate !== undefined) patch.isPrivate = input.isPrivate;
      const result = await patchFolder(
        context.authz.user.orgId,
        input.folderId,
        patch,
        context.authz.user.id,
        cabinetAudit(context),
      );
      if (!result.ok) {
        if (result.reason === "not found") throw notFound("folder");
        if (result.reason === "forbidden") throw forbidden("documents.manage");
        throw conflict(result.reason);
      }
      const folder = await getFolder(
        context.authz.user.orgId,
        input.folderId,
        cabinetViewer(context.authz),
      );
      if (!folder) throw notFound("folder");
      return { ok: true, folderId: input.folderId, folder, status: "updated", href: "/documents" };
    },
  }),
  definition({
    name: "delete_folder",
    title: "Delete Folder",
    description:
      "Move a folder subtree to the File Cabinet trash. Requires Manager access and refuses system folders or retained evidence; use list_folders to resolve the folder and restore_folder if recovery is needed.",
    inputSchema: z.object({ folderId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      await requireCabinetAccess(context, "folder", input.folderId, "manager");
      const result = await deleteFolder(
        context.authz.user.orgId,
        input.folderId,
        cabinetAudit(context),
      );
      if (!result.ok) {
        if (result.reason === "not found") throw notFound("folder");
        if (result.reason === "forbidden") throw forbidden("documents.manage");
        if (result.reason === "retained")
          throw conflict(
            "Folder contains retained evidence; release it through its owning records first.",
          );
        throw conflict(`Folder cannot be trashed: ${result.reason ?? "unknown refusal"}.`);
      }
      return { ok: true, folderId: input.folderId, status: "trashed", href: "/documents" };
    },
  }),
  definition({
    name: "restore_folder",
    title: "Restore Folder",
    description:
      "Restore a trashed folder subtree. Requires Manager access on the folder; use list_folders to find the folder and then verify the restored subtree.",
    inputSchema: z.object({ folderId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      await requireCabinetAccess(context, "folder", input.folderId, "manager", true);
      const ok = await restoreFolder(
        context.authz.user.orgId,
        input.folderId,
        cabinetAudit(context),
      );
      if (!ok) throw notFound("folder");
      return { ok: true, folderId: input.folderId, status: "active", href: "/documents" };
    },
  }),
  definition({
    name: "rename_file",
    title: "Rename File",
    description:
      "Rename a File Cabinet file while preserving its version history. Requires Editor access on the file; use list_files or get_file to resolve the id and verify the updated metadata.",
    inputSchema: z.object({
      fileId: UUID,
      name: z.string().trim().min(1).max(255).describe("New file name, including its extension."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) =>
      updateCabinetFile(context, input.fileId, { name: input.name }),
  }),
  definition({
    name: "move_file",
    title: "Move File",
    description:
      "Move a File Cabinet file to another folder. Requires Editor access on both the file and destination folder; use list_files and list_folders to resolve ids and verify the new folder.",
    inputSchema: z.object({
      fileId: UUID,
      folderId: UUID.describe("Destination folder."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) =>
      updateCabinetFile(context, input.fileId, { folderId: input.folderId }),
  }),
  definition({
    name: "delete_file",
    title: "Delete File",
    description:
      "Move a File Cabinet file to the trash while preserving its bytes and history. Requires Manager access and refuses retained evidence; use list_files or get_file to resolve the id and restore_file if recovery is needed.",
    inputSchema: z.object({ fileId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      await requireCabinetAccess(context, "file", input.fileId, "manager");
      const ok = await deleteFile(context.authz.user.orgId, input.fileId, cabinetAudit(context));
      if (!ok) {
        if (await isRetainedFileEvidence(context.authz.user.orgId, input.fileId)) {
          throw conflict(
            "This file is retained evidence; release it through its owning record first.",
          );
        }
        throw notFound("file");
      }
      return { ok: true, fileId: input.fileId, status: "trashed", href: "/documents" };
    },
  }),
  definition({
    name: "restore_file",
    title: "Restore File",
    description:
      "Restore a trashed File Cabinet file. Requires Manager access on the file; use list_files to resolve its id and verify the restored metadata.",
    inputSchema: z.object({ fileId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      await requireCabinetAccess(context, "file", input.fileId, "manager", true);
      const ok = await restoreFile(context.authz.user.orgId, input.fileId, cabinetAudit(context));
      if (!ok) throw notFound("file");
      const file = await getFile(
        context.authz.user.orgId,
        input.fileId,
        cabinetViewer(context.authz),
      );
      if (!file) throw notFound("file");
      return { ok: true, fileId: input.fileId, status: "active", file, href: "/documents" };
    },
  }),
  ...(["file", "folder"] as const).flatMap((resourceType) => {
    const title = resourceType === "file" ? "File" : "Folder";
    const noun = resourceType;
    const plural = resourceType === "file" ? "files" : "folders";
    return [
      definition({
        name: `list_${noun}_grants`,
        title: `List ${title} Grants`,
        description: `List sharing grants on a ${noun}. Requires Manager access; use list_files or list_folders to resolve the resource id.`,
        inputSchema: z.object({ resourceId: UUID }),
        readOnly: true,
        destructive: false,
        openWorld: false,
        assistantConfirmation: "never",
        visibleTo: permissionlessResourceGate,
        execute: async (context, input) =>
          listCabinetGrants(context, resourceType, input.resourceId),
      }),
      definition({
        name: `grant_${noun}_access`,
        title: `Grant ${title} Access`,
        description: `Create or update a ${noun} sharing grant. Requires Manager access; the recipient must be an organization user or role and its subsidiary scope must include the resource. Use list_${plural} and list_users/list_roles to resolve ids.`,
        inputSchema: grantInput,
        readOnly: false,
        destructive: false,
        openWorld: false,
        assistantConfirmation: "always",
        visibleTo: permissionlessResourceGate,
        execute: async (context, input) => {
          const { resourceId, ...grant } = input;
          return setCabinetGrant(
            context,
            resourceType,
            resourceId,
            grant.principalType,
            grant.principalId,
            grant.access,
          );
        },
      }),
      definition({
        name: `revoke_${noun}_access`,
        title: `Revoke ${title} Access`,
        description: `Remove one sharing grant from a ${noun}. Requires Manager access; use list_${noun}_grants to resolve the grant id and verify the remaining grants.`,
        inputSchema: z.object({ resourceId: UUID, grantId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
        readOnly: false,
        destructive: true,
        openWorld: false,
        assistantConfirmation: "always",
        visibleTo: permissionlessResourceGate,
        execute: async (context, input) =>
          revokeCabinetGrant(context, resourceType, input.resourceId, input.grantId),
      }),
    ];
  }),
  definition({
    name: "replace_file",
    title: "Replace File Version",
    description:
      "Upload a new version of a File Cabinet file while preserving prior versions. Requires Editor access and refuses retained evidence; use get_file or list_files to resolve the file id and verify the new version.",
    inputSchema: z.object({
      fileId: UUID,
      filename: z.string().min(1).max(255).describe("New version filename."),
      contentType: z
        .string()
        .min(1)
        .max(200)
        .describe("Allowed media type for the uploaded content."),
      contentBase64: z
        .string()
        .max(Math.ceil(MAX_BYTES / 3) * 4 + 4)
        .describe("File bytes encoded as base64, up to 25 MB decoded."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      const compact = input.contentBase64.replace(/\\s+/g, "");
      if (!BASE64.test(compact)) throw invalidInput("contentBase64 is not valid base64.");
      const bytes = Buffer.from(compact, "base64");
      if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString("base64") !== compact)
        throw invalidInput("File content must be valid base64 for 1 byte to 25 MB.");
      if (!isAllowedContentType(input.contentType))
        throw invalidInput(`unsupported file type: ${input.contentType || "unknown"}`);
      await requireCabinetAccess(context, "file", input.fileId, "editor");
      const ok = await replaceFile({
        orgId: context.authz.user.orgId,
        fileId: input.fileId,
        filename: input.filename,
        contentType: input.contentType.split(";")[0]!.trim().toLowerCase(),
        bytes,
        updatedBy: context.authz.user.id,
        audit: { actorId: context.authz.user.id, viewer: cabinetViewer(context.authz) },
      });
      if (!ok) {
        if (await isRetainedFileEvidence(context.authz.user.orgId, input.fileId))
          throw conflict("This file is retained evidence and cannot be replaced.");
        throw notFound("file");
      }
      const file = await getFile(
        context.authz.user.orgId,
        input.fileId,
        cabinetViewer(context.authz),
      );
      if (!file) throw notFound("file");
      return { ok: true, fileId: input.fileId, file, status: "replaced", href: "/documents" };
    },
  }),
  definition({
    name: "attach_file_to_record",
    title: "Attach File to Record",
    description:
      "Link an existing visible File Cabinet file to a supported record. Requires the record's write permission and subsidiary access; use list_files and the record list to resolve fileId, targetTable, and targetId.",
    inputSchema: z.object({
      fileId: UUID,
      targetTable: z
        .string()
        .max(200)
        .refine(isAttachableTargetTable, "targetTable must be an attachable record type")
        .describe("Supported record table from the attachment catalog."),
      targetId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      const orgId = context.authz.user.orgId;
      const target = await loadAttachmentTarget(orgId, input.targetTable, input.targetId);
      if (!target || !attachmentTargetInScope(context.authz, target)) throw notFound("record");
      if (!(await canMutateAttachmentTarget(context.authz, target)))
        throw new ApplicationError("forbidden", "forbidden", 403);
      if (!(await getFile(orgId, input.fileId, fileViewer(context.authz)))) throw notFound("file");
      try {
        const id = await attachExisting({
          orgId,
          fileId: input.fileId,
          targetTable: input.targetTable,
          targetId: input.targetId,
          createdBy: context.authz.user.id,
          authorizeTarget: (tx) =>
            authorizeAttachmentTargetMutation(context.authz, input.targetTable, input.targetId, tx),
        });
        if (!id) throw conflict("already attached");
        return {
          ok: true,
          attachmentId: id,
          fileId: input.fileId,
          targetId: input.targetId,
          status: "attached",
          href: `/documents/${input.fileId}`,
        };
      } catch (error) {
        if (error instanceof AttachmentMutationRefusal) {
          if (error.status === 404) throw notFound("record");
          throw new ApplicationError("forbidden", error.message, 403);
        }
        throw error;
      }
    },
  }),
  definition({
    name: "detach_file_from_record",
    title: "Detach File from Record",
    description:
      "Remove a file attachment link without deleting the cabinet file. Requires read and write access to the target record and refuses retained evidence; use the record attachment list to resolve attachmentId.",
    inputSchema: z.object({ attachmentId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: permissionlessResourceGate,
    execute: async (context, input) => {
      requireAuthenticated(context);
      const orgId = context.authz.user.orgId;
      const link = await getAttachmentLink(orgId, input.attachmentId);
      if (!link) throw notFound("attachment");
      const target = await loadAttachmentTarget(orgId, link.targetTable, link.targetId);
      if (!target || !attachmentTargetInScope(context.authz, target)) throw notFound("record");
      if (
        !(await canReadAttachmentTarget(context.authz, target)) ||
        !(await canMutateAttachmentTarget(context.authz, target))
      )
        throw new ApplicationError("forbidden", "forbidden", 403);
      try {
        const result = await detachAttachment(orgId, input.attachmentId, {
          actorId: context.authz.user.id,
          authorizeAttachmentTarget: (tx, identity) =>
            authorizeAttachmentTargetMutation(
              context.authz,
              identity.targetTable,
              identity.targetId,
              tx,
            ),
        });
        if (!result.ok) {
          if (result.reason === "retained")
            throw conflict("attachments of posted or active records are retained");
          throw notFound("attachment");
        }
        return {
          ok: true,
          attachmentId: input.attachmentId,
          fileId: link.fileId,
          status: "detached",
          href: "/documents",
        };
      } catch (error) {
        if (error instanceof AttachmentMutationRefusal) {
          if (error.status === 404) throw notFound("record");
          throw new ApplicationError("forbidden", error.message, 403);
        }
        throw error;
      }
    },
  }),
];

async function updateCabinetFile(
  context: ApplicationContext,
  fileId: string,
  patch: { name?: string; folderId?: string },
) {
  requireAuthenticated(context);
  await requireCabinetAccess(context, "file", fileId, "editor");
  if (patch.folderId) {
    if (!(await getFolder(context.authz.user.orgId, patch.folderId)))
      throw notFound("destination folder");
    await requireCabinetAccess(context, "folder", patch.folderId, "editor");
  }
  await inDbTransaction(async (tx) => {
    const audit = { ...cabinetAudit(context), executor: tx };
    if (patch.name !== undefined) {
      const renamed = await renameFile(
        context.authz.user.orgId,
        fileId,
        patch.name,
        context.authz.user.id,
        audit,
      );
      if (!renamed) throw notFound("file");
    }
    if (patch.folderId !== undefined) {
      const moved = await moveFile(
        context.authz.user.orgId,
        fileId,
        patch.folderId,
        context.authz.user.id,
        audit,
      );
      if (!moved) throw invalidInput("file cannot be moved to that folder");
    }
  });
  const file = await getFile(context.authz.user.orgId, fileId, cabinetViewer(context.authz));
  if (!file) throw notFound("file");
  return { ok: true, fileId, file, status: "updated", href: "/documents" };
}
