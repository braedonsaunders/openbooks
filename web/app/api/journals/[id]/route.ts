import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/db.ts'
import { sum, toUnits } from '@openbooks/engine/src/money.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { guardPermission } from '../../../../lib/authz'
import { loadJournalDoc } from '../../../../lib/journals'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { segmentRegistry, validateExtraDims } from '../../../../lib/segments'
import { exactMoney, isoDate, nullableUuidId, parseJsonBody, uuidId } from '../../../../lib/api/json'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const journal = await loadJournalDoc(id, gate.user.orgId)
  if (!journal) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(journal)
}

const journalLineInput = z
  .object({
    accountId: uuidId,
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
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute<{ status: string }>(
    sql`select status from documents where id = ${id} and kind = 'journal' and org_id = ${user.orgId}`,
  ))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json(
      { error: `a ${existing.rows[0].status} journal cannot be edited — create a correcting journal instead` },
      { status: 422 },
    )
  }
  const parsed = await parseJsonBody(req, journalPatchBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const requestedSubsidiaries = [...new Set([
    ...(body.subsidiaryId ? [body.subsidiaryId] : []),
    ...(body.lines ?? []).flatMap((line) => line.subsidiaryId ? [line.subsidiaryId] : []),
  ])]
  if (requestedSubsidiaries.length) {
    const subsidiaries = (await db.execute(sql`
      select id from subsidiaries
       where org_id = ${user.orgId} and is_active and not is_elimination
         and id = any(${`{${requestedSubsidiaries.join(',')}}`}::uuid[])`)) as any
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
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    headerCustom = v.cleaned
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
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        return NextResponse.json(
          { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
          { status: 422 },
        )
      }
      const lineDims = validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) return NextResponse.json({ error: `Line ${i + 1}: ${lineDims.error}` }, { status: 422 })
      preparedLines.push({
        accountId: l.accountId,
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

  await db.transaction(async (tx) => {
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
          updated_at = now(), updated_by = ${user.id}
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
  })

  const journal = await loadJournalDoc(id, user.orgId)
  return NextResponse.json(journal)
}

/** Delete a journal (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const owned = (await db.execute(
    sql`select 1 from documents where id = ${id} and kind = 'journal' and org_id = ${gate.user.orgId}`,
  ))
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    await deleteDocument(id, gate.user.id, gate.user.orgId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
