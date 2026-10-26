import {
  loadAttachmentTarget,
  attachmentTargetInScope,
  type AttachmentTarget,
} from "@openbooks/engine/records/file-attachment-target";
import { NextResponse } from "next/server";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { can, getAuthz, type Authz } from "../../../lib/authz";
import {
  accessAtLeast,
  attachmentReadPermission,
  fileAccessLevel,
  folderAccessLevel,
  getFile,
  listAttachments,
  type AttachedFile,
  type AccessLevel,
  type FileViewer,
} from "../../../lib/file-cabinet";
import { expenseAccess, expenseAccessAllows } from "../../../lib/expense-access";

export const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Content-type allowlist. Files are only stored/served with a type on this
 * list; the download route additionally sends `X-Content-Type-Options: nosniff`
 * so browsers never re-interpret the bytes.
 */
export const ALLOWED_CONTENT_TYPES: Record<string, true> = {
  "application/pdf": true,
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "text/csv": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "text/plain": true,
  // Text/code files — safe to store and serve: the download route sends
  // `X-Content-Type-Options: nosniff`, and the preview reads them as text into
  // a textarea (never executed).
  "text/markdown": true,
  "text/javascript": true,
  "application/json": true,
  "application/xml": true,
  "text/xml": true,
};

export function isAllowedContentType(ct: string): boolean {
  return ALLOWED_CONTENT_TYPES[ct.split(";")[0]!.trim().toLowerCase()] === true;
}

/**
 * Permission gate for file cabinet mutations.
 *
 * Reading files requires `documents.read` for cabinet-wide views, while the
 * attachment listing additionally gates on the owning record's permission;
 * org scoping + private-folder visibility in web/lib/file-cabinet.ts do the
 * file-row filtering.
 *
 * Mutating (upload, move, rename, delete, attach/detach) requires
 * `documents.manage` OR one of the document-write permissions that let the
 * user work with a document (so attaching to bills/invoices still works for
 * AP/AR clerks). Admin's `*` covers everything.
 */
const DOCUMENT_ATTACHMENT_WRITE_PERMS: Record<string, string> = {
  vendor_bill: "ap.create",
  vendor_payment: "ap.pay",
  vendor_credit: "ap.create",
  purchase_order: "purchase_orders.create",
  check: "ap.create",
  card_charge: "ap.create",
  card_refund: "ap.create",
  customer_invoice: "ar.create",
  customer_credit: "ar.create",
  customer_payment: "ar.pay",
  sales_order: "ar.create",
  quote: "ar.create",
  expense_report: "expenses.create",
  field_ticket: "time.manage",
  pick_list: "orders.fulfill",
  shipment: "orders.fulfill",
  project_charge: "projects.manage",
  pay_run: "payroll.run",
  journal: "gl.post",
  deposit: "gl.post",
  transfer: "gl.post",
};

export function canMutateFiles(authz: Authz, targetTable?: string, kind?: string | null): boolean {
  if (can(authz, "documents.manage")) return true;
  if (targetTable === "item_rate_versions") return can(authz, "admin.setup.manage");
  if (targetTable === "fixed_assets") return can(authz, "assets.manage");
  if (targetTable !== "documents") return false;
  const permission = kind ? DOCUMENT_ATTACHMENT_WRITE_PERMS[kind] : undefined;
  return permission !== undefined && can(authz, permission);
}

/**
 * Whether the caller may attach to or detach from this loaded record: the
 * kind's write grant, or the self-service grant on their own expense report.
 */
export async function canMutateAttachmentTarget(
  authz: Authz,
  target: AttachmentTarget,
  executor?: SqlExecutor,
): Promise<boolean> {
  if (canMutateFiles(authz, target.targetTable, target.kind)) return true;
  return ownExpenseReportTarget(authz, target, "edit", executor);
}

/**
 * Whether the caller may read this loaded record's attachments: the owning
 * record's read grant, or the self-service grant on their own expense report.
 */
export async function canReadAttachmentTarget(
  authz: Authz,
  target: AttachmentTarget,
  executor?: SqlExecutor,
): Promise<boolean> {
  const permission = attachmentReadPermission(target.targetTable, target.kind);
  if (!permission) return false;
  if (can(authz, permission)) return true;
  return ownExpenseReportTarget(authz, target, "read", executor);
}

async function ownExpenseReportTarget(
  authz: Authz,
  target: AttachmentTarget,
  authority: "read" | "edit",
  executor?: SqlExecutor,
): Promise<boolean> {
  if (target.targetTable !== "documents" || target.kind !== "expense_report") return false;
  const access = await expenseAccess(authz, authority, executor);
  return access !== null && expenseAccessAllows(access, target.documentPartyId);
}

/**
 * The cabinet viewer for a record's attachments. Evidence attached to an
 * expense report the caller may read is readable with the report, so its
 * reader needs no cabinet-wide grant to open their own receipts.
 */
export function attachmentViewer(authz: Authz, target: AttachmentTarget): FileViewer {
  const viewer = fileViewer(authz);
  if (
    viewer.baseline !== "none" ||
    target.targetTable !== "documents" ||
    target.kind !== "expense_report"
  )
    return viewer;
  return { ...viewer, baseline: "viewer" };
}

export { ATTACHABLE_TARGET_TABLES, isAttachableTargetTable } from "./target-tables";

export {
  loadAttachmentTarget,
  attachmentTargetInScope,
  type AttachmentTarget,
} from "@openbooks/engine/records/file-attachment-target";

/** Combined target lookup + legal-entity gate used by attachment writes. */
export async function attachmentTargetVisible(
  authz: Authz,
  targetTable: string,
  targetId: string,
): Promise<boolean> {
  const target = await loadAttachmentTarget(authz.user.orgId, targetTable, targetId);
  return target !== null && attachmentTargetInScope(authz, target);
}

export class AttachmentMutationRefusal extends Error {
  constructor(readonly status: 403 | 404) {
    super(status === 404 ? "not found" : "forbidden");
  }
}

/** Recheck target identity, scope, and kind permission under the write transaction's row lock. */
export async function authorizeAttachmentTargetMutation(
  authz: Authz,
  targetTable: string,
  targetId: string,
  executor: SqlExecutor,
): Promise<void> {
  const target = await loadAttachmentTarget(
    authz.user.orgId,
    targetTable,
    targetId,
    executor,
    true,
  );
  if (!target || !attachmentTargetInScope(authz, target)) throw new AttachmentMutationRefusal(404);
  if (!(await canMutateAttachmentTarget(authz, target, executor)))
    throw new AttachmentMutationRefusal(403);
}

export function attachmentMutationRefusal(error: unknown): NextResponse | null {
  if (!(error instanceof AttachmentMutationRefusal)) return null;
  return NextResponse.json({ error: error.message }, { status: error.status });
}

export { attachmentReadPermission };

/**
 * List only attachment metadata whose file is visible to this caller. The
 * cabinet's getFile() is the owning visibility primitive (private folder and
 * direct-file grants); inactive files are omitted as well.
 */
export async function listVisibleAttachments(
  orgId: string,
  targetTable: string,
  targetId: string,
  viewer: FileViewer,
): Promise<AttachedFile[]> {
  const items = await listAttachments(orgId, targetTable, targetId);
  const visible = await Promise.all(
    items.map(async (item) => {
      const file = await getFile(orgId, item.id, viewer);
      return file && !file.isInactive ? item : null;
    }),
  );
  return visible.filter((item): item is AttachedFile => item !== null);
}

/** Resolve authz or the 401 response. */
export async function requireSession(): Promise<Authz | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return authz;
}

/**
 * The caller as a FileViewer for access control. `*` admins get Manager
 * everywhere; otherwise the org-role baseline is Manager for documents.manage,
 * Viewer for documents.read (the gate every cabinet route already passed).
 * resource_grants layer on top per folder/file.
 */
export function fileViewer(authz: Authz): FileViewer {
  const baseline: AccessLevel = can(authz, "documents.manage")
    ? "manager"
    : can(authz, "documents.read")
      ? "viewer"
      : "none";
  return {
    userId: authz.user.id,
    isAdmin: can(authz, "*"),
    baseline,
    canReadApCapture: can(authz, "ap.read"),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  };
}

/** Gate: the caller must have at least `min` access on a folder. */
export async function requireFolderAccess(
  authz: Authz,
  folderId: string,
  min: AccessLevel,
): Promise<NextResponse | null> {
  const level = await folderAccessLevel(authz.user.orgId, fileViewer(authz), folderId);
  if (!accessAtLeast(level, min)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}

/** Gate: the caller must have at least `min` access on a file. */
export async function requireFileAccess(
  authz: Authz,
  fileId: string,
  min: AccessLevel,
  options: { includeInactive?: boolean } = {},
): Promise<NextResponse | null> {
  const level = await fileAccessLevel(
    authz.user.orgId,
    fileViewer(authz),
    fileId,
    undefined,
    options,
  );
  if (!accessAtLeast(level, min)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}
