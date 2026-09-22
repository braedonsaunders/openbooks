import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../lib/api/idempotency'
import { sum, toUnits } from '@openbooks/engine/src/money/money.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/records/numbering.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission, subsidiariesInScope } from '../../../lib/authz'
import { loadJournalDoc } from '../../../lib/journals'
import { isUuid } from '../../../lib/list-params'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from '../../../lib/custom-fields'
import { segmentRegistry, validateExtraDims } from '../../../lib/segments'
import { exactMoney, isoDate, nullableUuidId, parseJsonBody, uuidId } from '../../../lib/api/json'

export const runtime = 'nodejs'

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
}

/** One manual-journal leg — the same shape PATCH accepts, minus nothing:
 *  the create path and the edit path validate identical legs. */
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
  // A zero leg carries no financial meaning; refuse it instead of silently
  // dropping a submitted line at the posting boundary (same rule as PATCH).
  .refine((line) => toUnits(line.amount) !== 0n, 'journal line amounts cannot be zero')

const journalCreateBody = z.object({
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

function trimOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

/**
 * Create one draft manual journal with its lines.
 *
 * The caller supplies a UUID idempotency key, which becomes the document ID.
 * The first write allocates the JE- number inside the locked save
 * transaction and inserts exactly one document, its lines, and one audit
 * row carrying the key as its request correlation. Retrying the exact
 * request replays the same journal (200); reusing the key for a changed
 * payload, or for a key minted in another org, is a 409 — never the older
 * journal returned as though it matched.
 *
 * This is the only first-party write path for new journals: the list opens
 * an unsaved drawer (zero writes) and this endpoint persists it exactly
 * once. The legacy draft factory stays for backward-compatible
 * integrations only.
 */
export async function POST(request: Request) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return bad('invalid_idempotency_key', undefined, 400)

  const parsed = await parseJsonBody(request, journalCreateBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const lines = body.lines ?? []
  if (lines.length === 0) return bad('add at least one journal line', 'lines')
  // Balanced, non-empty: debits equal credits and something actually moves.
  // Compared in exact bigint units — canonical string forms may differ in
  // scale, so string equality of the sums would be fragile here.
  const totalDebits = sum(lines.map((line) => (toUnits(line.amount) > 0n ? line.amount : '0')))
  const net = sum(lines.map((line) => line.amount))
  if (toUnits(totalDebits) <= 0n || toUnits(net) !== 0n) {
    return bad('journal lines must balance with a non-zero total', 'lines')
  }

  // -- subsidiary: the journal's legal entity --------------------------------
  // Explicit ids must be active, non-elimination, and inside the caller's
  // scope; without one, unrestricted callers take the root and restricted
  // callers need exactly one available entity (same decision table as the
  // legacy draft factory, minus the write).
  let subsidiary: { id: string; base_currency: string }
  if (body.subsidiaryId) {
    if (gate.allowedSubsidiaryIds !== null && !gate.allowedSubsidiaryIds.has(body.subsidiaryId)) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    const explicit = (await db.execute<{ id: string; base_currency: string }>(sql`
      select id, base_currency from subsidiaries
       where org_id = ${user.orgId} and id = ${body.subsidiaryId}
         and is_active and not is_elimination`)).rows[0]
    if (!explicit) return bad('invalid subsidiary', 'subsidiaryId')
    subsidiary = explicit
  } else if (gate.allowedSubsidiaryIds === null) {
    const root = (await db.execute<{ id: string; base_currency: string }>(sql`
      select id, base_currency from subsidiaries where org_id = ${user.orgId} and parent_id is null`))
    if (!root.rows[0]) return bad('org has no root subsidiary', undefined, 500)
    subsidiary = root.rows[0]
  } else {
    const ids = [...gate.allowedSubsidiaryIds].filter((id) => isUuid(id))
    const allowed = ids.length
      ? (await db.execute<{ id: string; base_currency: string }>(sql`
          select id, base_currency from subsidiaries
           where org_id = ${user.orgId} and is_active and not is_elimination
             and id = any(${`{${ids.join(',')}}`}::uuid[])`)).rows
      : []
    if (allowed.length === 0) return bad('no_available_subsidiary', undefined, 409)
    if (allowed.length !== 1) return bad('subsidiary_selection_required', 'subsidiaryId', 409)
    subsidiary = allowed[0]!
  }

  // -- custom fields + segments against the live defs -------------------------
  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs('documents', 'journal'),
    loadFieldDefs('document_lines', 'journal'),
    segmentRegistry(user.orgId),
  ])
  const headerDims = validateExtraDims(body.extraDims, segments)
  if (!headerDims.ok) return bad(headerDims.error)
  const headerCustomResult = validateCustomValues(headerDefs, body.custom ?? {})
  if (!headerCustomResult.ok) {
    return NextResponse.json(
      { error: Object.values(headerCustomResult.errors)[0], fieldErrors: headerCustomResult.errors },
      { status: 422 },
    )
  }
  const unownedHeaderRefs = await findUnownedCustomReferences(user.orgId, headerDefs, headerCustomResult.cleaned)
  if (unownedHeaderRefs.length > 0) {
    const def = unownedHeaderRefs[0]!
    return NextResponse.json({ error: `${def.label} not found in this organization` }, { status: 404 })
  }

  // -- referenced rows: every uuid must resolve inside this org ---------------
  const partyId = body.partyId ?? null
  if (partyId) {
    const party = (await db.execute<{ id: string }>(sql`
      select id from parties where id = ${partyId} and org_id = ${user.orgId} and is_active`))
    if (!party.rows[0]) return NextResponse.json({ error: 'party not found in this organization' }, { status: 404 })
  }
  const requestedSubsidiaries = [...new Set([
    ...lines.flatMap((line) => (line.subsidiaryId ? [line.subsidiaryId] : [])),
  ])]
  if (requestedSubsidiaries.length && !subsidiariesInScope(gate, requestedSubsidiaries)) {
    return bad('invalid subsidiary', 'lines')
  }
  if (requestedSubsidiaries.length) {
    const owned = (await db.execute(sql`
      select id from subsidiaries
       where org_id = ${user.orgId} and is_active and not is_elimination
         and id = any(${`{${requestedSubsidiaries.join(',')}}`}::uuid[])`))
    if (owned.rows.length !== requestedSubsidiaries.length) return bad('invalid subsidiary', 'lines')
  }
  // Line accounts are the tenant's chart of accounts: a foreign account dies
  // at the insert as an unhandled storage error, so refuse it here with a
  // domain 404 that reveals nothing about other tenants' charts.
  const lineAccountIds = [...new Set(lines.map((l) => l.accountId))]
  const ownedAccounts = (await db.execute<{ id: string }>(sql`
    select id from accounts
     where org_id = ${user.orgId} and id = any(${`{${lineAccountIds.join(',')}}`}::uuid[])`))
  if (ownedAccounts.rows.length !== lineAccountIds.length) {
    return NextResponse.json({ error: 'account not found in this organization' }, { status: 404 })
  }
  for (const ref of [
    { ids: lines.map((l) => l.departmentId).filter(Boolean) as string[], table: 'departments' },
    { ids: lines.map((l) => l.projectId).filter(Boolean) as string[], table: 'projects' },
    { ids: lines.map((l) => l.partyId).filter(Boolean) as string[], table: 'parties' },
  ]) {
    if (!ref.ids.length) continue
    const unique = [...new Set(ref.ids)]
    const found = (await db.execute(sql`
      select id from ${sql.raw(ref.table)}
       where org_id = ${user.orgId} and id = any(${`{${unique.join(',')}}`}::uuid[])`))
    if (found.rows.length !== unique.length) {
      return NextResponse.json({ error: `${ref.table} reference not found in this organization` }, { status: 404 })
    }
  }

  const preparedLines: {
    accountId: string
    description: string | null
    amount: string
    partyId: string | null
    departmentId: string | null
    projectId: string | null
    subsidiaryId: string | null
    extraDims: Record<string, string>
    custom: Record<string, unknown>
  }[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const lv = validateCustomValues(lineDefs, l.custom)
    if (!lv.ok) {
      return NextResponse.json(
        { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
        { status: 422 },
      )
    }
    const unownedLineRefs = await findUnownedCustomReferences(user.orgId, lineDefs, lv.cleaned)
    if (unownedLineRefs.length > 0) {
      const def = unownedLineRefs[0]!
      return NextResponse.json(
        { error: `Line ${i + 1}: ${def.label} not found in this organization` },
        { status: 404 },
      )
    }
    const lineDims = validateExtraDims(l.extraDims, segments)
    if (!lineDims.ok) return bad(`Line ${i + 1}: ${lineDims.error}`, 'lines')
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

  const documentDate = body.documentDate ?? (await businessToday(user.orgId))
  const referenceNumber = trimOrNull(body.referenceNumber)
  const memo = trimOrNull(body.memo)
  // The replay match is the canonical request-controlled subset: the
  // operation, the kind, and the caller's fields exactly as supplied.
  // Server-derived values — the defaulted date, the resolved subsidiary and
  // currency, the derived totals, the allocated number — are EXCLUDED: they
  // depend on live clock/config/sequence state, so comparing them would turn
  // a genuine retry into a conflict. They still persist in the full
  // snapshot below. A null date/subsidiary here means "the caller omitted
  // it", which is itself part of the request identity.
  const match = {
    kind: 'journal',
    partyId: body.partyId ?? null,
    documentDate: body.documentDate ?? null,
    referenceNumber: body.referenceNumber ?? null,
    memo: body.memo ?? null,
    subsidiaryId: body.subsidiaryId ?? null,
    extraDims: body.extraDims ?? null,
    custom: body.custom ?? null,
    lines: body.lines ?? [],
  }
  // The persisted image is the full immutable create snapshot (derived
  // values included) plus the request match above, so audit evidence stays
  // complete while replay compares only what the caller controlled.
  const snapshot = {
    request: match,
    id: requestId,
    org_id: user.orgId,
    kind: 'journal',
    subsidiary_id: subsidiary.id,
    document_date: documentDate,
    currency: subsidiary.base_currency,
    party_id: partyId,
    reference_number: referenceNumber,
    memo,
    extra_dims: headerDims.cleaned,
    custom: headerCustomResult.cleaned,
    subtotal: totalDebits,
    total: totalDebits,
    lines: preparedLines.map((l, index) => ({
      line_number: index + 1,
      account_id: l.accountId,
      description: l.description,
      amount: l.amount,
      party_id: l.partyId,
      department_id: l.departmentId,
      project_id: l.projectId,
      subsidiary_id: l.subsidiaryId,
      extra_dims: l.extraDims,
      custom: l.custom,
    })),
  }

  let created = false
  try {
    created = await db.transaction(async (tx) => {
      // Serialize every request carrying this key: without the lock, two
      // concurrent identical Saves could both read no row, both allocate a
      // number, and the loser would 409 on the insert conflict instead of
      // replaying 200. The lock is keyed only — it carries no tenant read.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`)
      // Same-org claim only — never a bare by-id read: a key minted in
      // another org must not be observable here. A foreign/global UUID
      // collision surfaces below at the insert conflict, without reading it.
      const claim = await claimIdempotentCreate(tx, { orgId: user.orgId, table: 'documents', key: requestId })
      // Replay compares the immutable request image in the insert audit
      // event — not today's row, and not the derived values — so an
      // unchanged retry still succeeds after a later PATCH legitimately
      // edited the journal, or after the clock/config moved under a
      // defaulted field.
      const replayMatch = { request: match }
      if (claim === 'exists') {
        const replay = await resolveIdempotentReplay(tx, {
          orgId: user.orgId, table: 'documents', key: requestId, match: replayMatch,
        })
        if (replay !== 'replay') throw new Error('idempotency_key_conflict')
        return false
      }
      // First write for this key: the number is allocated here, inside the
      // locked save transaction — opening the drawer never consumed one.
      const documentNumber = await allocateDocumentNumber(tx, user.orgId, 'journal', 'JE-')
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into documents
          (id, org_id, kind, status, subsidiary_id, document_number, document_date,
           currency, party_id, reference_number, memo, extra_dims, custom,
           subtotal, tax_total, total, created_by, updated_by)
        values
          (${requestId}, ${user.orgId}, 'journal', 'draft', ${subsidiary.id}, ${documentNumber},
           ${documentDate}, ${subsidiary.base_currency}, ${partyId}, ${referenceNumber}, ${memo},
           ${JSON.stringify(headerDims.cleaned)}::jsonb, ${JSON.stringify(headerCustomResult.cleaned)}::jsonb,
           ${totalDebits}, '0', ${totalDebits}, ${user.id}, ${user.id})
        on conflict (id) do nothing
        returning id`))
      if (!inserted.rows[0]) {
        // Lost insert race or foreign/global UUID collision: the re-read
        // decides — a genuine retry replays, anything else conflicts, all
        // without reading another org's row.
        const replay = await resolveIdempotentReplay(tx, {
          orgId: user.orgId, table: 'documents', key: requestId, match: replayMatch,
        })
        if (replay !== 'replay') throw new Error('idempotency_key_conflict')
        return false
      }
      for (let i = 0; i < preparedLines.length; i++) {
        const l = preparedLines[i]!
        await tx.execute(sql`
          insert into document_lines (org_id, document_id, line_number, account_id, description,
                                      quantity, unit_price, amount, party_id, department_id, project_id,
                                      subsidiary_id, extra_dims, custom)
          values (${user.orgId}, ${requestId}, ${i + 1}, ${l.accountId}, ${l.description},
                  '1', ${l.amount}, ${l.amount}, ${l.partyId}, ${l.departmentId}, ${l.projectId},
                  ${l.subsidiaryId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)}::jsonb)`)
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${user.orgId}, 'documents', ${requestId}, 'insert',
                ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
                ${user.id}, ${requestId})`)
      return true
    })
  } catch (error) {
    const message = error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
      : String(error)
    if (message.includes('idempotency_key_conflict')) return bad('invalid_idempotency_key', undefined, 409)
    throw error
  }

  const journal = await loadJournalDoc(requestId, user.orgId)
  if (!journal) return bad('save_failed', undefined, 500)
  return NextResponse.json(journal, { status: created ? 201 : 200 })
}
