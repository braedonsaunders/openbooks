import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, getAuthz, subsidiaryScopeAllows, type Authz } from '../../../lib/authz'
import { accessAtLeast, fileAccessLevel, folderAccessLevel, getFile, listAttachments, type AttachedFile, type AccessLevel, type FileViewer } from '../../../lib/file-cabinet'

export const MAX_BYTES = 25 * 1024 * 1024 // 25 MB

/**
 * Content-type allowlist. Files are only stored/served with a type on this
 * list; the download route additionally sends `X-Content-Type-Options: nosniff`
 * so browsers never re-interpret the bytes.
 */
export const ALLOWED_CONTENT_TYPES: Record<string, true> = {
  'application/pdf': true,
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'text/csv': true,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
  'text/plain': true,
  // Text/code files — safe to store and serve: the download route sends
  // `X-Content-Type-Options: nosniff`, and the preview reads them as text into
  // a textarea (never executed).
  'text/markdown': true,
  'text/javascript': true,
  'application/json': true,
  'application/xml': true,
  'text/xml': true,
}

export function isAllowedContentType(ct: string): boolean {
  return ALLOWED_CONTENT_TYPES[ct.split(';')[0]!.trim().toLowerCase()] === true
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
const DOCUMENT_WRITE_PERMS = ['documents.manage', 'ap.create', 'ar.create', 'expenses.create', 'gl.post']

export function canMutateFiles(authz: Authz, targetTable?: string): boolean {
  if (can(authz, 'documents.manage')) return true
  if (targetTable === 'item_rate_versions') return can(authz, 'admin.setup.manage')
  if (targetTable === 'fixed_assets') return can(authz, 'assets.manage')
  if (targetTable !== 'documents') return false
  return DOCUMENT_WRITE_PERMS.some((p) => can(authz, p))
}

export { ATTACHABLE_TARGET_TABLES, isAttachableTargetTable } from './target-tables'

/**
 * The record behind an attachment target, including the legal-entity columns
 * needed to apply the caller's subsidiary scope before listing metadata.
 * Documents and fixed assets own their subsidiary directly; compliance rows
 * and lien waivers inherit it from their project (or party when no project is
 * present).
 */
export interface AttachmentTarget {
  targetTable: string
  targetId: string
  kind: string | null
  subsidiaryId: string | null
  partySubsidiaryId: string | null
  projectSubsidiaryId: string | null
}

/** Load an attachment target without disclosing anything outside the org. */
export async function loadAttachmentTarget(orgId: string, targetTable: string, targetId: string): Promise<AttachmentTarget | null> {
  type RawTarget = {
    kind?: string | null
    subsidiaryId?: string | null
    partySubsidiaryId?: string | null
    projectSubsidiaryId?: string | null
  }
  const row = (
    targetTable === 'documents'
      ? (
          await db.execute<{ kind: string; subsidiaryId: string | null }>(sql`
        select kind, subsidiary_id as "subsidiaryId"
          from documents
         where id = ${targetId} and org_id = ${orgId}`)
        ).rows[0]
      : targetTable === 'parties'
        ? (
            await db.execute<{ subsidiaryId: string | null }>(sql`
          select subsidiary_id as "subsidiaryId"
            from parties
           where id = ${targetId} and org_id = ${orgId}`)
          ).rows[0]
        : targetTable === 'item_rate_versions'
          ? (
              await db.execute(sql`
            select id
              from item_rate_versions
             where id = ${targetId} and org_id = ${orgId}`)
            ).rows[0]
          : targetTable === 'fixed_assets'
            ? (
                await db.execute<{ subsidiaryId: string | null }>(sql`
              select subsidiary_id as "subsidiaryId"
                from fixed_assets
               where id = ${targetId} and org_id = ${orgId}`)
              ).rows[0]
            : targetTable === 'compliance_records'
              ? (
                  await db.execute<{
                    partySubsidiaryId: string | null
                    projectSubsidiaryId: string | null
                  }>(sql`
                select p.subsidiary_id as "partySubsidiaryId",
                       pj.subsidiary_id as "projectSubsidiaryId"
                  from compliance_records cr
                  join parties p on p.id = cr.party_id and p.org_id = cr.org_id
                  left join projects pj on pj.id = cr.project_id and pj.org_id = cr.org_id
                 where cr.id = ${targetId} and cr.org_id = ${orgId}`)
                ).rows[0]
              : targetTable === 'lien_waivers'
                ? (
                    await db.execute<{
                      partySubsidiaryId: string | null
                      projectSubsidiaryId: string | null
                    }>(sql`
                  select p.subsidiary_id as "partySubsidiaryId",
                         pj.subsidiary_id as "projectSubsidiaryId"
                    from lien_waivers lw
                    join parties p on p.id = lw.party_id and p.org_id = lw.org_id
                  join projects pj on pj.id = lw.project_id and pj.org_id = lw.org_id
                   where lw.id = ${targetId} and lw.org_id = ${orgId}`)
                  ).rows[0]
                : undefined
  ) as RawTarget | undefined

  if (!row) return null
  return {
    targetTable,
    targetId,
    kind: targetTable === 'documents' ? (row.kind ?? null) : null,
    subsidiaryId: targetTable === 'documents' || targetTable === 'parties' || targetTable === 'fixed_assets' ? (row.subsidiaryId ?? null) : null,
    partySubsidiaryId: targetTable === 'compliance_records' || targetTable === 'lien_waivers' ? (row.partySubsidiaryId ?? null) : null,
    projectSubsidiaryId: targetTable === 'compliance_records' || targetTable === 'lien_waivers' ? (row.projectSubsidiaryId ?? null) : null,
  }
}

/** Apply row/legal-entity visibility to an already-loaded target. */
export function attachmentTargetInScope(authz: Authz, target: AttachmentTarget): boolean {
  if (authz.allowedSubsidiaryIds === null) return true

  // Rate-card versions are org-wide setup records: the table has no
  // subsidiary dimension, and the rate-book APIs intentionally expose them to
  // any caller holding admin.setup.manage regardless of subsidiary scope.
  if (target.targetTable === 'item_rate_versions') return true

  if (target.targetTable === 'parties') {
    return subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.subsidiaryId, { orgWideNull: true })
  }

  if (target.targetTable === 'compliance_records') {
    // A project is the legal entity when present; an unprojected certificate
    // follows the vendor party's primary legal entity. Both linked rows must
    // remain visible when both carry a subsidiary, so a cross-entity link
    // cannot be used to disclose evidence from the hidden side.
    const partyVisible = subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.partySubsidiaryId, { orgWideNull: true })
    const projectVisible = target.projectSubsidiaryId === null || subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.projectSubsidiaryId)
    return partyVisible && projectVisible
  }

  if (target.targetTable === 'lien_waivers') {
    const partyVisible = subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.partySubsidiaryId, { orgWideNull: true })
    const projectVisible = target.projectSubsidiaryId === null || subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.projectSubsidiaryId)
    return partyVisible && projectVisible
  }

  return subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.subsidiaryId)
}

/** Combined target lookup + legal-entity gate used by attachment writes. */
export async function attachmentTargetVisible(authz: Authz, targetTable: string, targetId: string): Promise<boolean> {
  const target = await loadAttachmentTarget(authz.user.orgId, targetTable, targetId)
  return target !== null && attachmentTargetInScope(authz, target)
}

/** Owning resource permission for a target (or its document kind). */
export function attachmentReadPermission(targetTable: string, kind?: string | null): string | null {
  if (targetTable === 'documents') {
    const documentPermissions: Record<string, string> = {
      vendor_bill: 'ap.read',
      vendor_payment: 'ap.pay',
      vendor_credit: 'ap.read',
      purchase_order: 'ap.read',
      check: 'ap.read',
      card_charge: 'ap.read',
      card_refund: 'ap.read',
      customer_invoice: 'ar.read',
      customer_credit: 'ar.read',
      customer_payment: 'ar.pay',
      sales_order: 'ar.read',
      quote: 'ar.read',
      expense_report: 'expenses.read',
      field_ticket: 'time.read',
      project_charge: 'projects.read',
      pay_run: 'payroll.read',
      journal: 'gl.read',
      deposit: 'gl.read',
      transfer: 'gl.read',
    }
    return kind ? (documentPermissions[kind] ?? null) : null
  }
  if (targetTable === 'parties') return 'parties.read'
  if (targetTable === 'item_rate_versions') return 'admin.setup.manage'
  if (targetTable === 'fixed_assets') return 'assets.read'
  if (targetTable === 'compliance_records' || targetTable === 'lien_waivers') return 'compliance.read'
  return null
}

/**
 * List only attachment metadata whose file is visible to this caller. The
 * cabinet's getFile() is the owning visibility primitive (private folder and
 * direct-file grants); inactive files are omitted as well.
 */
export async function listVisibleAttachments(orgId: string, targetTable: string, targetId: string, viewer: FileViewer): Promise<AttachedFile[]> {
  const items = await listAttachments(orgId, targetTable, targetId)
  const visible = await Promise.all(
    items.map(async (item) => {
      const file = await getFile(orgId, item.id, viewer)
      return file && !file.isInactive ? item : null
    }),
  )
  return visible.filter((item): item is AttachedFile => item !== null)
}

/** Resolve authz or the 401 response. */
export async function requireSession(): Promise<Authz | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return authz
}

/**
 * The caller as a FileViewer for access control. `*` admins get Manager
 * everywhere; otherwise the org-role baseline is Manager for documents.manage,
 * Viewer for documents.read (the gate every cabinet route already passed).
 * resource_grants layer on top per folder/file.
 */
export function fileViewer(authz: Authz): FileViewer {
  const baseline: AccessLevel = can(authz, 'documents.manage') ? 'manager' : can(authz, 'documents.read') ? 'viewer' : 'none'
  return { userId: authz.user.id, isAdmin: can(authz, '*'), baseline }
}

/** Gate: the caller must have at least `min` access on a folder. */
export async function requireFolderAccess(authz: Authz, folderId: string, min: AccessLevel): Promise<NextResponse | null> {
  const level = await folderAccessLevel(authz.user.orgId, fileViewer(authz), folderId)
  if (!accessAtLeast(level, min)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}

/** Gate: the caller must have at least `min` access on a file. */
export async function requireFileAccess(authz: Authz, fileId: string, min: AccessLevel): Promise<NextResponse | null> {
  const level = await fileAccessLevel(authz.user.orgId, fileViewer(authz), fileId)
  if (!accessAtLeast(level, min)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}
