import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { sum, toUnits } from '@openbooks/engine/src/money/money.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/ledger/document-delete.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/records/transaction-audit.ts'
import { guardPermission, guardSubsidiaryScope, subsidiariesInScope } from '../../../../lib/authz'
import { DocumentEditError, requireDocumentEditRevision, runDocumentVersionedTransaction } from "../../../../../engine/src/records/document-edit-policy.ts";
import { documentRevisionCounterSql } from "../../../../../engine/src/records/revision.ts";
import { loadJournalDoc } from '../../../../lib/journals'
import { isUuid } from '../../../../lib/list-params'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { segmentRegistry, validateExtraDims } from '../../../../lib/segments'
import { exactMoney, isoDate, nullableUuidId, parseJsonBody } from '../../../../lib/api/json'

type RouteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Replace the lossy JavaScript Date `updated_at` with the exact canonical OCC
 * token, mirroring loadDocument: node-postgres maps timestamptz to Date, which
 * discards the microseconds PostgreSQL retains, so a caller that echoes the
 * raw value back as its expected revision could never match under lock.
 */
async function withExactDocumentRevision<T extends { doc: Record<string, unknown> }>(
  payload: T,
  id: string,
  orgId: string,
): Promise<T> {
  const row = (await db.execute<{ updatedAt: string }>(sql`
    select ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
      from documents where id = ${id} and org_id = ${orgId}
  `))
  if (row.rows[0]) payload.doc = { ...payload.doc, updated_at: row.rows[0].updatedAt }
  return payload
}

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const owned = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = 'journal' and org_id = ${gate.user.orgId}`,
  ))
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId)
  if (denied) return denied
  const journal = await loadJournalDoc(id, gate.user.orgId)
  if (!journal) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(await withExactDocumentRevision(journal, id, gate.user.orgId))
}

const journalLineInput = z
  .object({
    // Blank/malformed accounts pass the boundary so the handler below can
    // refuse them with the line number (a bare uuid failure names neither
    // the line nor the remedy).
    accountId: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    amount: exactMoney(),
    partyId: nullableUuidId.optional(),
    departmentId: nullableUuidId.optional(),
    projectId: nullableUuidId.optional(),
    subsidiaryId: nullableUuidId.optional(),
    extraDims: z.record(z.string(), z.string().nullable()).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  // A zero leg carries no financial meaning; reject it instead of silently
  // dropping a submitted line at the posting boundary.
  .refine((line) => toUnits(line.amount) !== 0n, 'journal line amounts cannot be zero')

const journalPatchBody = z.object({
  /** Optimistic concurrency token from documents.revision_seq (exact form). */
  expectedUpdatedAt: z.string().optional(),
  partyId: nullableUuidId.optional(),
  documentDate: isoDate().optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  /** null = org root (posting resolves it). Only sent by multi-subsidiary orgs. */
  subsidiaryId: nullableUuidId.optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  lines: z.array(journalLineInput).optional(),
})

/**
 * Autosave a manual-journal draft. Once it enters approval or posts, the
 * original is preserved and the user creates a separate correcting journal.
 *
 * Saves are fenced by the document's exact revision: the caller echoes the
 * `updated_at` token it loaded, and the write happens only when that token
 * still matches the row locked FOR UPDATE inside the same transaction — so
 * two concurrent saves can never silently overwrite one another.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = (await db.execute<{ status: string; subsidiaryId: string | null; custom: Record<string, unknown> | null }>(
    sql`select status, subsidiary_id as "subsidiaryId", custom from documents where id = ${id} and kind = 'journal' and org_id = ${user.orgId}`,
  ))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, existing.rows[0].subsidiaryId)
  if (denied) return denied
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json(
      { error: `a ${existing.rows[0].status} journal cannot be edited — create a correcting journal instead` },
      { status: 422 },
    )
  }
  const parsed = await parseJsonBody(req, journalPatchBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  // Every journal carries its legal entity. Posting falls back to the root
  // when the header is null, but subsidiary-scoped readers exclude null rows,
  // so an explicit clear would hide the live journal while leaving its ledger
  // impact intact. Line-level nulls remain valid and fall back to the header.
  if (body.subsidiaryId === null) {
    return NextResponse.json(
      { error: 'a journal requires a subsidiary; the subsidiary cannot be removed' },
      { status: 422 },
    )
  }
  // Mandatory optimistic-concurrency evidence — same contract as /api/documents/[id].
  let expectedRevision: string
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
  const requestedSubsidiaries = [...new Set([
    ...(body.subsidiaryId ? [body.subsidiaryId] : []),
    ...(body.lines ?? []).flatMap((line) => line.subsidiaryId ? [line.subsidiaryId] : []),
  ])]
  // A restricted caller may not move a journal (header or any leg) to a
  // subsidiary they cannot see — even one that exists and is active.
  if (requestedSubsidiaries.length && !subsidiariesInScope(gate, requestedSubsidiaries)) {
    return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
  }
  if (requestedSubsidiaries.length) {
    const subsidiaries = ((await db.execute(sql`
      select id from subsidiaries
       where org_id = ${user.orgId} and is_active and not is_elimination
         and id = any(${`{${requestedSubsidiaries.join(',')}}`}::uuid[])`)))
    if (subsidiaries.rows.length !== requestedSubsidiaries.length) {
      return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
    }
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs('documents', 'journal'),
    loadFieldDefs('document_lines', 'journal'),
    segmentRegistry(user.orgId),
  ])
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) return NextResponse.json({ error: headerDims.error }, { status: 422 })
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    // PATCH custom values are partial: validate the effective bag so an
    // omitted required field can be satisfied by its stored value, then
    // merge the cleaned submitted values over the stored bag so omitted
    // keys survive. The exact-revision guard below rejects the write if a
    // concurrent edit moved the stored bag after this read.
    const existingCustom =
      existing.rows[0].custom && typeof existing.rows[0].custom === 'object'
        ? (existing.rows[0].custom as Record<string, unknown>)
        : {}
    const v = validateCustomValues(headerDefs, { ...existingCustom, ...body.custom })
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    // Reference custom values are uuid-SHAPED at this point but nothing
    // proves the referenced row belongs to the caller: refuse foreign or
    // dangling ids with a tenant-opaque 404 instead of persisting a
    // cross-tenant pointer. Supplied values only, so legacy bags written
    // before this fence cannot lock unrelated edits.
    const suppliedHeaderCustom: Record<string, unknown> = {}
    for (const key of Object.keys(body.custom)) {
      if (v.cleaned[key] !== undefined) suppliedHeaderCustom[key] = v.cleaned[key]
    }
    const unownedHeaderRefs = await findUnownedCustomReferences(user.orgId, headerDefs, suppliedHeaderCustom)
    if (unownedHeaderRefs.length > 0) {
      const def = unownedHeaderRefs[0]!
      return NextResponse.json({ error: `${def.label} not found in this organization` }, { status: 404 })
    }
    headerCustom = { ...existingCustom, ...v.cleaned }
  }

  // Pre-validate + prepare lines (read-only) before touching the DB, so a bad
  // line returns 422 without a partial write. Amounts, account references, and
  // line shape are already canonical here (the zod boundary above); custom
  // fields and segments are org-configured and validated against live defs.
  // journal totals = sum of debits (positive line amounts); tax never applies
  let totalDebits: string | null = null
  let preparedLines: { accountId: string; description: string | null; amount: string; partyId: string | null; departmentId: string | null; projectId: string | null; subsidiaryId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown> }[] | null = null
  if (body.lines) {
    const submitted = body.lines
    totalDebits = sum(submitted.map((line) => (toUnits(line.amount) > 0n ? line.amount : '0')))
    preparedLines = []
    for (let i = 0; i < submitted.length; i++) {
      const l = submitted[i]!
      // Every submitted leg must name its account: the drawers send every
      // contentful row (OM-09b), so an account-less row arrives here rather
      // than vanishing client-side — name its line instead of booking
      // without it. Malformed ids get the same line-numbered treatment the
      // boundary's anonymous uuid failure never gave them.
      const accountId = l.accountId
      if (typeof accountId !== 'string' || accountId.trim() === '') {
        return NextResponse.json({ error: `Line ${i + 1}: an account is required` }, { status: 422 })
      }
      if (!isUuid(accountId)) {
        return NextResponse.json({ error: `Line ${i + 1}: invalid account` }, { status: 422 })
      }
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        return NextResponse.json(
          { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
          { status: 422 },
        )
      }
      // Lines are replaced wholesale, so the whole submitted line bag is
      // newly supplied: refuse foreign or dangling reference ids with the
      // same tenant-opaque 404 the line-account precheck below returns.
      const unownedLineRefs = await findUnownedCustomReferences(user.orgId, lineDefs, lv.cleaned)
      if (unownedLineRefs.length > 0) {
        const def = unownedLineRefs[0]!
        return NextResponse.json(
          { error: `Line ${i + 1}: ${def.label} not found in this organization` },
          { status: 404 },
        )
      }
      const lineDims = validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) return NextResponse.json({ error: `Line ${i + 1}: ${lineDims.error}` }, { status: 422 })
      preparedLines.push({
        accountId,
        description: l.description ?? null,
        amount: l.amount,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        subsidiaryId: l.subsidiaryId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
      })
    }
  }

  // Line accounts are the tenant's chart of accounts. The lines FK is
  // tenant-coherent, so a foreign account dies at the re-insert as an
  // unhandled storage error; refuse it here with a domain 404 that reveals
  // nothing about other tenants' charts (same contract as the shared
  // applyDocumentEdit service). The per-line loop above guarantees every
  // submitted accountId is a uuid string.
  if (preparedLines) {
    const lineAccountIds = [...new Set(preparedLines.map((l) => l.accountId))]
    const owned = lineAccountIds.length
      ? (await db.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${user.orgId} and id = any(${`{${lineAccountIds.join(',')}}`}::uuid[])`)).rows
      : []
    if (owned.length !== lineAccountIds.length) {
      return NextResponse.json({ error: 'account not found in this organization' }, { status: 404 })
    }
  }

  try {
    await runDocumentVersionedTransaction<
      RouteTransaction,
      { status: string; updatedAt: string },
      void
    >({
      expectedRevision,
      transaction: (work) => db.transaction(work),
      // The row lock and exact revision comparison are the first operations in
      // the write transaction: a concurrent writer cannot slip between the
      // check and the header/line replacement.
      lock: async (tx) => (await tx.execute<{ status: string; updatedAt: string }>(sql`
        select status,
               ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
          from documents
         where id = ${id} and kind = 'journal' and org_id = ${user.orgId}
         for update
      `)).rows[0] ?? null,
      mutate: async (tx, locked) => {
        if (locked.status !== 'draft') {
          throw new DocumentEditError(
            422,
            `a ${locked.status} journal cannot be edited — create a correcting journal instead`,
          )
        }

        const auditBefore = await captureTransactionAuditSnapshot(tx, id, user.orgId)
        if (!auditBefore) throw new Error(`journal ${id} disappeared before update`)

        if (preparedLines) {
          await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${user.orgId}`)
          for (let i = 0; i < preparedLines.length; i++) {
            const l = preparedLines[i]!
            await tx.execute(sql`
              insert into document_lines (org_id, document_id, line_number, account_id, description,
                                          quantity, unit_price, amount, party_id, department_id, project_id,
                                          subsidiary_id, extra_dims, custom)
              values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.description},
                      '1', ${l.amount}, ${l.amount}, ${l.partyId}, ${l.departmentId}, ${l.projectId},
                      ${l.subsidiaryId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)})
            `)
          }
        }

        await tx.execute(sql`
          update documents set
            party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
            document_date = coalesce(${body.documentDate ?? null}, document_date),
            reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
            memo = ${body.memo !== undefined ? body.memo : sql`memo`},
            subsidiary_id = ${body.subsidiaryId !== undefined ? body.subsidiaryId : sql`subsidiary_id`},
            extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
            custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
            subtotal = coalesce(${totalDebits}, subtotal),
            total = coalesce(${totalDebits}, total),
            updated_at = greatest(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            ),
            updated_by = ${user.id}
          where id = ${id} and org_id = ${user.orgId}
        `)

        const auditAfter = await captureTransactionAuditSnapshot(tx, id, user.orgId)
        if (!auditAfter) throw new Error(`journal ${id} disappeared during update`)
        await recordTransactionAudit(tx, {
          orgId: user.orgId,
          documentId: id,
          action: 'update',
          actorId: user.id,
          source: 'ui',
          before: auditBefore,
          after: auditAfter,
        })
      },
    })
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json(
        { error: e.message, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) },
        { status: e.status },
      )
    }
    // Composite org-scoped storage keys make cross-tenant references
    // unrepresentable; map their FK refusal to a domain 422 instead of a
    // raw 500. The whole save (lines + header + totals) rolls back, so a
    // mixed payload cannot half-save. Line accounts are prechecked above
    // with a tenant-opaque 404; this fence covers the header party and
    // every other line reference (party, department, project, ...).
    if (isTenantReferenceViolation(e)) {
      return NextResponse.json(
        { error: 'referenced party, department, project, or dimension must belong to this organization' },
        { status: 422 },
      )
    }
    throw e
  }

  const journal = await loadJournalDoc(id, user.orgId)
  if (!journal) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(await withExactDocumentRevision(journal, id, user.orgId))
}

/** Walk the driver-error cause chain for a tenant-coherent FK refusal (23503). */
function isTenantReferenceViolation(error: unknown): boolean {
  let cursor: unknown = error
  for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === 'object'; depth++) {
    if ((cursor as { code?: unknown }).code === '23503') return true
    cursor = (cursor as { cause?: unknown }).cause
  }
  return false
}

/** Delete a journal (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const owned = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = 'journal' and org_id = ${gate.user.orgId}`,
  ))
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId)
  if (denied) return denied
  try {
    await deleteDocument(id, gate.user.id, gate.user.orgId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
