/** Split from web/lib/file-cabinet.ts (ARCH-FILE-SPLIT; pure moves only). */
import 'server-only'
import { sql, type SQL } from 'drizzle-orm'

// --- types ------------------------------------------------------------------

/**
 * The authenticated caller, for access control. Beyond private-folder
 * visibility (is_private → owner + admins only), access is layered:
 *   - isAdmin (holds '*') → Manager everywhere.
 *   - baseline: the org-role tier — 'manager' for documents.manage, 'viewer'
 *     for documents.read — applied to every folder outside a private subtree
 *     the caller doesn't own. Defaults to 'viewer' when unset (back-compat:
 *     every caller that reaches these functions already passed documents.read).
 *   - resource_grants add Viewer/Editor/Manager to specific users/roles on a
 *     folder (inherited by descendants + contained files) or a single file.
 */
export interface FileViewer {
  userId: string
  isAdmin: boolean
  baseline?: AccessLevel
  /** AP-capture intake is governed by its owning AP capability, not documents.read. */
  canReadApCapture?: boolean
  /**
   * The caller's role-derived subsidiary fence (null = organization-wide).
   * Record-folder files/folders evidence a single record, so restricted
   * callers see them only when the folder's record target is inside this
   * set — the same rule the attachment surfaces enforce. Unset behaves as
   * unrestricted (pre-fence callers and tests keep current behavior).
   */
  allowedSubsidiaryIds?: ReadonlySet<string> | null
}

/** Permission required to read an attachment through its owning record. */
export function attachmentReadPermission(targetTable: string, kind?: string | null): string | null {
  if (targetTable === 'documents') {
    const permissions: Record<string, string> = {
      vendor_bill: 'ap.read', vendor_payment: 'ap.pay', vendor_credit: 'ap.read', purchase_order: 'ap.read',
      check: 'ap.read', card_charge: 'ap.read', card_refund: 'ap.read', customer_invoice: 'ar.read',
      customer_credit: 'ar.read', customer_payment: 'ar.pay', sales_order: 'ar.read', quote: 'ar.read',
      expense_report: 'expenses.read', field_ticket: 'time.read', project_charge: 'projects.read',
      pay_run: 'payroll.read', journal: 'gl.read', deposit: 'gl.read', transfer: 'gl.read',
    }
    return kind ? (permissions[kind] ?? null) : null
  }
  if (targetTable === 'parties') return 'parties.read'
  if (targetTable === 'item_rate_versions') return 'admin.setup.manage'
  if (targetTable === 'fixed_assets') return 'assets.read'
  if (targetTable === 'compliance_records' || targetTable === 'lien_waivers') return 'compliance.read'
  return null
}

/** Access tiers, low → high. 'none' means no access. */
export type AccessLevel = 'none' | 'viewer' | 'editor' | 'manager'

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, viewer: 1, editor: 2, manager: 3 }
export const ACCESS_BY_RANK: AccessLevel[] = ['none', 'viewer', 'editor', 'manager']

export function accessAtLeast(level: AccessLevel, min: AccessLevel): boolean {
  return ACCESS_RANK[level] >= ACCESS_RANK[min]
}

export function maxAccess(...levels: AccessLevel[]): AccessLevel {
  return ACCESS_BY_RANK[Math.max(0, ...levels.map((l) => ACCESS_RANK[l]))]!
}

/** SQL predicate: a grant row applies to this viewer (direct user grant, or a
 *  grant to a role the viewer holds via role_assignments). */
export function grantAppliesTo(orgId: string, viewer: FileViewer): SQL {
  return sql`(
    (g.principal_type = 'user' and g.principal_id = ${viewer.userId})
    or (g.principal_type = 'role' and g.principal_id in (
      select role_id from role_assignments where org_id = ${orgId} and user_id = ${viewer.userId}
    ))
  )`
}

export type FolderNode = {
  id: string
  name: string
  parentId: string | null
  isSystem: boolean
  systemKind: string | null
  isPrivate: boolean
  isInactive: boolean
  recordTable: string | null
  recordId: string | null
  childCount: number
  fileCount: number
};

export type FileMeta = {
  id: string
  folderId: string
  name: string
  extension: string | null
  fileType: string
  contentType: string
  sizeBytes: number
  isInactive: boolean
  currentVersionId: string | null
  versionCount: number
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
  folderName: string | null
};

export interface FileDetail extends FileMeta {
  versions: FileVersion[]
  attachments: FileAttachmentLink[]
}

export interface FileVersion {
  id: string
  versionNumber: number
  sizeBytes: number
  contentType: string
  contentHash: string | null
  createdAt: string
  createdBy: string | null
}

export interface FileAttachmentLink {
  id: string
  targetTable: string
  targetId: string
  createdAt: string
}
