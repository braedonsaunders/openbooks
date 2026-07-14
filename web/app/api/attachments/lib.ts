import { NextResponse } from 'next/server'
import { can, getAuthz, type Authz } from '../../../lib/authz'

export const MAX_BYTES = 25 * 1024 * 1024 // 25 MB

/**
 * Content-type allowlist. Files are only stored/served with a type on this
 * list; the download route additionally sends `X-Content-Type-Options: nosniff`
 * so browsers never re-interpret the bytes.
 */
export const ALLOWED_CONTENT_TYPES: Record<string, true> = {
  'application/pdf': true,
  'image/png': true,
  'image/jpeg': true, // jpg + jpeg
  'image/gif': true,
  'text/csv': true,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true, // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true, // docx
  'text/plain': true, // txt
}

export function isAllowedContentType(ct: string): boolean {
  return ALLOWED_CONTENT_TYPES[ct.split(';')[0].trim().toLowerCase()] === true
}

/**
 * Permission gate for attaching/removing files.
 *
 * Reading a file (list, download) requires only an authenticated session in
 * the owning org — org scoping in web/lib/attachments.ts is the real boundary.
 *
 * Mutating (create/delete) is stricter: the user must be authenticated AND, for
 * the `documents` target table (transactions: bills, invoices, payments,
 * expenses, journals), hold at least one write permission that lets them work
 * with a document — any of ap.create / ar.create / expenses.create / gl.post
 * (or admin's `*`, which covers them all). For every other target table an
 * authenticated session is sufficient. Deliberately simple: a single
 * document write capability, not per-kind gating, because attachments ride
 * alongside documents rather than being their own guarded resource.
 */
const DOCUMENT_WRITE_PERMS = ['ap.create', 'ar.create', 'expenses.create', 'gl.post']

export function canMutateAttachments(authz: Authz, targetTable: string): boolean {
  if (targetTable !== 'documents') return true
  return DOCUMENT_WRITE_PERMS.some((p) => can(authz, p))
}

/** Resolve authz or the 401 response. */
export async function requireSession(): Promise<Authz | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return authz
}
