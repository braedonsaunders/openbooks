import { NextResponse } from 'next/server'
import { can, getAuthz, type Authz } from '../../../lib/authz'
import {
  accessAtLeast,
  fileAccessLevel,
  folderAccessLevel,
  type AccessLevel,
  type FileViewer,
} from '../../../lib/file-cabinet'

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
  return ALLOWED_CONTENT_TYPES[ct.split(';')[0].trim().toLowerCase()] === true
}

/**
 * Permission gate for file cabinet mutations.
 *
 * Reading (list, download) requires `documents.read` — the same gate as the
 * /documents page — enforced per-route via guardPermission; org scoping +
 * private-folder visibility in web/lib/file-cabinet.ts do the row filtering.
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
  const baseline: AccessLevel = can(authz, 'documents.manage')
    ? 'manager'
    : can(authz, 'documents.read')
      ? 'viewer'
      : 'none'
  return { userId: authz.user.id, isAdmin: can(authz, '*'), baseline }
}

/** Gate: the caller must have at least `min` access on a folder. */
export async function requireFolderAccess(
  authz: Authz,
  folderId: string,
  min: AccessLevel,
): Promise<NextResponse | null> {
  const level = await folderAccessLevel(authz.user.orgId, fileViewer(authz), folderId)
  if (!accessAtLeast(level, min)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}

/** Gate: the caller must have at least `min` access on a file. */
export async function requireFileAccess(
  authz: Authz,
  fileId: string,
  min: AccessLevel,
): Promise<NextResponse | null> {
  const level = await fileAccessLevel(authz.user.orgId, fileViewer(authz), fileId)
  if (!accessAtLeast(level, min)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}
