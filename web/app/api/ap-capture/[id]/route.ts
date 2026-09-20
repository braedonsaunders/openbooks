import { exactMoney, jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { getDocumentCaptureSettings } from '@openbooks/engine/src/payables/ap-capture-config.ts'
import type { CaptureLine, NormalizedCapture } from '@openbooks/engine/src/payables/ap-capture.ts'
import { resolveAndValidateCapture } from '@openbooks/engine/src/payables/ap-capture-service.ts'
import { documentRevisionCounterSql, isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { guardPermission } from '../../../../lib/authz'
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { isFeatureEnabled } from '../../../../lib/features'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

function optionalText(value: unknown, max = 500): string | null {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, max) : null
}

function optionalUuid(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error('invalid_capture_reference')
  const text = value.trim()
  if (!text) return null
  if (!UUID.test(text)) throw new Error('invalid_capture_reference')
  return text
}

const reviewMoney = exactMoney('invalid_capture_amount')

// OCR heuristics belong to provider extraction. A human correction must not
// strip characters or substitute zero for an invalid amount.
function money(value: unknown, fallback: string | null = null): string | null {
  if (value == null || value === '') return fallback
  const parsed = reviewMoney.safeParse(value)
  if (!parsed.success) throw new Error('invalid_capture_amount')
  return parsed.data
}

function parseNormalized(raw: unknown): NormalizedCapture {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_capture')
  const row = raw as Record<string, unknown>
  if (!Array.isArray(row.lines)) throw new Error('invalid_lines')
  const sourceLines = row.lines
  if (sourceLines.length > 500) throw new Error('too_many_lines')
  const lines: CaptureLine[] = sourceLines.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_line')
    const line = value as Record<string, unknown>
    const amount = money(line.amount, '0.0000')!
    return {
      description: String(line.description ?? '').trim().slice(0, 1_000),
      productCode: optionalText(line.productCode, 200),
      quantity: money(line.quantity, '1.0000')!,
      unit: optionalText(line.unit, 50),
      unitPrice: money(line.unitPrice, amount)!,
      amount,
      taxAmount: money(line.taxAmount, '0.0000')!,
      accountId: optionalUuid(line.accountId),
      itemId: optionalUuid(line.itemId),
      purchaseOrderLineId: optionalUuid(line.purchaseOrderLineId),
      confidence: money(line.confidence),
    }
  })
  return {
    vendorName: optionalText(row.vendorName),
    vendorTaxId: optionalText(row.vendorTaxId, 200),
    invoiceNumber: optionalText(row.invoiceNumber, 200),
    invoiceDate: optionalText(row.invoiceDate, 10),
    dueDate: optionalText(row.dueDate, 10),
    purchaseOrderNumber: optionalText(row.purchaseOrderNumber, 200),
    currency: optionalText(row.currency, 3)?.toUpperCase() ?? null,
    subtotal: money(row.subtotal),
    taxTotal: money(row.taxTotal),
    total: money(row.total),
    memo: optionalText(row.memo, 2_000),
    lines,
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  // A malformed id names nothing: same answer as an unknown one, never a
  // PostgreSQL uuid cast error escaping as a 500.
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const result = (await db.execute<Record<string, unknown>>(sql`
    select ci.*, f.content_type, f.size_bytes
      from ap_capture_items ci join files f on f.id = ci.file_id and f.org_id = ci.org_id
     where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
  `))
  if (!result.rows[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const [fields, events] = await Promise.all([
    db.execute(sql`
      select af.* from ap_capture_fields af join ap_capture_runs ar on ar.id = af.run_id and ar.org_id = af.org_id
       where af.org_id = ${gate.user.orgId} and ar.capture_item_id = ${id}
       order by ar.attempt desc, af.field_key, af.line_index nulls first
    `),
    db.execute(sql`
      select * from ap_capture_events where org_id = ${gate.user.orgId} and capture_item_id = ${id}
       order by at desc
    `),
  ])
  return NextResponse.json({ item: result.rows[0], fields: ((fields)).rows, events: ((events)).rows })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  // Mandatory optimistic-concurrency evidence (same contract as document,
  // payment, and prebill-line edits): a stale review tab autosaves over a
  // newer correction otherwise. Checked after the gates so a missing token
  // never leaks capture existence to an unauthorized caller.
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json({ error: 'A current capture revision is required; reload the capture and try again' }, { status: 409 })
  }
  const expectedRevision = body.expectedUpdatedAt as string
  let normalized: NormalizedCapture
  let nextVendorId: string | null | undefined
  let nextPurchaseOrderId: string | null | undefined
  try {
    normalized = parseNormalized(body.normalized)
    if (body.documentKind !== undefined && body.documentKind !== 'vendor_bill' && body.documentKind !== 'vendor_credit') {
      throw new Error('invalid_document_kind')
    }
    nextVendorId = body.vendorId === undefined ? undefined : optionalUuid(body.vendorId)
    nextPurchaseOrderId = body.purchaseOrderId === undefined ? undefined : optionalUuid(body.purchaseOrderId)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid_capture' }, { status: 422 })
  }
  const current = (await db.execute<{ normalized: NormalizedCapture; status: string; document_kind: string; vendor_candidate_id: string | null; purchase_order_id: string | null }>(sql`
    select normalized, status, document_kind, vendor_candidate_id, purchase_order_id from ap_capture_items
     where org_id = ${gate.user.orgId} and id = ${id}
  `))
  if (!current.rows[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (['materialized', 'rejected', 'extracting', 'queued'].includes(current.rows[0].status)) {
    return NextResponse.json({ error: 'not_editable' }, { status: 409 })
  }
  // Stored captures stay when itemId is omitted. Re-sending the stored item
  // is allowed. A new inventory / assembly / kit item is Inventory configuration.
  if (!(await isFeatureEnabled(gate.user.orgId, 'inventory'))) {
    const storedIds = new Set(
      (current.rows[0].normalized.lines ?? [])
        .map((line) => line.itemId)
        .filter((itemId): itemId is string => Boolean(itemId)),
    )
    for (const line of normalized.lines) {
      if (!line.itemId || storedIds.has(line.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${gate.user.orgId}`))
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }
  // Stored equipment_charge lines stay. Turning Equipment off must
  // 404 a write that would persist a new one of those kinds.
  if (!(await isFeatureEnabled(gate.user.orgId, 'equipment'))) {
    const storedIds = new Set(
      (current.rows[0].normalized.lines ?? [])
        .map((line) => line.itemId)
        .filter((itemId): itemId is string => Boolean(itemId)),
    )
    for (const line of normalized.lines) {
      if (!line.itemId || storedIds.has(line.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${gate.user.orgId}`))
      if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }
  if (
    nextPurchaseOrderId
    && nextPurchaseOrderId !== current.rows[0].purchase_order_id
    && !(await isDocKindEnabled(gate.user.orgId, 'purchase_order'))
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const settings = await getDocumentCaptureSettings(gate.user.orgId)
  let saved: { resolved: Awaited<ReturnType<typeof resolveAndValidateCapture>>; kind: 'vendor_bill' | 'vendor_credit' }
  try {
    saved = await withOrgTransaction(gate.user.orgId, async () => {
      const tx = db
      const locked = (await tx.execute<{ normalized: NormalizedCapture; status: string; document_kind: string; vendor_candidate_id: string | null; purchase_order_id: string | null; revision: string }>(sql`
        select normalized, status, document_kind, vendor_candidate_id, purchase_order_id,
               ${documentRevisionCounterSql(sql`revision_seq`)} as revision
          from ap_capture_items where org_id = ${gate.user.orgId} and id = ${id} for update
      `))
      const live = locked.rows[0]
      if (!live) throw new Error('capture_not_found')
      if (['materialized', 'rejected', 'extracting', 'queued'].includes(live.status)) throw new Error('capture_not_editable')
      // The row lock above serializes concurrent saves; the token decides the
      // winner. A tab that read before a sibling's save committed refuses
      // loudly instead of reverting that save's corrections.
      if (live.revision !== expectedRevision) throw new Error('capture_revision_conflict')
      const kind = body.documentKind === undefined ? live.document_kind : body.documentKind
      if (kind !== 'vendor_bill' && kind !== 'vendor_credit') throw new Error('invalid_document_kind')
      // Resolve against the kind being saved, using the same locked snapshot as
      // the correction audit. Omission preserves a selected vendor credit.
      const resolved = await resolveAndValidateCapture({
        orgId: gate.user.orgId, captureItemId: id, normalized,
        confidenceThreshold: settings.confidenceThreshold,
        vendorId: nextVendorId, purchaseOrderId: nextPurchaseOrderId, documentKind: kind,
    })
    const before = live.normalized
    const headerKeys = ['vendorName', 'vendorTaxId', 'invoiceNumber', 'invoiceDate', 'dueDate', 'purchaseOrderNumber', 'currency', 'subtotal', 'taxTotal', 'total', 'memo'] as const
    for (const key of headerKeys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(resolved.normalized[key])) {
        await tx.execute(sql`
          insert into ap_capture_corrections (org_id, capture_item_id, field_key, before_value, after_value, corrected_by)
          values (${gate.user.orgId}, ${id}, ${key}, ${JSON.stringify(before[key])}::jsonb,
                  ${JSON.stringify(resolved.normalized[key])}::jsonb, ${gate.user.id})
        `)
      }
    }
    const maxLines = Math.max(before.lines.length, resolved.normalized.lines.length)
    for (let lineIndex = 0; lineIndex < maxLines; lineIndex += 1) {
      if (JSON.stringify(before.lines[lineIndex] ?? null) !== JSON.stringify(resolved.normalized.lines[lineIndex] ?? null)) {
        await tx.execute(sql`
          insert into ap_capture_corrections (org_id, capture_item_id, field_key, line_index, before_value, after_value, corrected_by)
          values (${gate.user.orgId}, ${id}, 'line', ${lineIndex},
                  ${JSON.stringify(before.lines[lineIndex] ?? null)}::jsonb,
                  ${JSON.stringify(resolved.normalized.lines[lineIndex] ?? null)}::jsonb, ${gate.user.id})
        `)
      }
    }
    const selections: Array<[string, unknown, unknown]> = [
      ['documentKind', live.document_kind, kind],
      ['vendorCandidateId', live.vendor_candidate_id, resolved.vendorId],
      ['purchaseOrderId', live.purchase_order_id, resolved.purchaseOrderId],
    ]
    for (const [fieldKey, beforeValue, afterValue] of selections) {
      if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue
      await tx.execute(sql`
        insert into ap_capture_corrections (org_id, capture_item_id, field_key, before_value, after_value, corrected_by)
        values (${gate.user.orgId}, ${id}, ${fieldKey}, ${JSON.stringify(beforeValue)}::jsonb,
                ${JSON.stringify(afterValue)}::jsonb, ${gate.user.id})
      `)
    }
    const status = resolved.duplicate ? 'duplicate' : resolved.issues.length ? 'needs_review' : 'ready'
    // Monotonic revision writer (same discipline as document revisions): every
    // committed save advances the token, so equal tokens always mean equal
    // content and a stale tab can never accidentally match.
    await tx.execute(sql`
      update ap_capture_items set normalized = ${JSON.stringify(resolved.normalized)}::jsonb,
             validation_issues = ${JSON.stringify(resolved.issues)}::jsonb, status = ${status},
             document_kind = ${kind}, vendor_candidate_id = ${resolved.vendorId},
             purchase_order_id = ${resolved.purchaseOrderId}, assigned_to = ${gate.user.id},
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${gate.user.id}
       where org_id = ${gate.user.orgId} and id = ${id}
    `)
    await tx.execute(sql`
      insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
      values (${gate.user.orgId}, ${id}, 'review_saved',
              ${JSON.stringify({ status, issueCount: resolved.issues.length })}::jsonb, ${gate.user.id})
    `)
    return { resolved, kind }
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_document_kind') {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    if (error instanceof Error && error.message === 'capture_not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    if (error instanceof Error && error.message === 'capture_not_editable') {
      return NextResponse.json({ error: 'not_editable' }, { status: 409 })
    }
    if (error instanceof Error && error.message === 'capture_revision_conflict') {
      return NextResponse.json({ error: 'This capture changed after you opened it; reload and reapply your corrections' }, { status: 409 })
    }
    throw error
  }
  const { resolved, kind } = saved
  // Fresh token for the next save: the drawer holds no revision otherwise and
  // every follow-up keystroke would 409 against its own just-committed write.
  const fresh = (await db.execute<{ updatedAt: string }>(sql`
    select ${documentRevisionCounterSql(sql`revision_seq`)} as "updatedAt"
      from ap_capture_items where org_id = ${gate.user.orgId} and id = ${id}
  `)).rows[0]?.updatedAt ?? expectedRevision
  return NextResponse.json({
    normalized: resolved.normalized,
    validationIssues: resolved.issues,
    vendorId: resolved.vendorId,
    purchaseOrderId: resolved.purchaseOrderId,
    status: resolved.duplicate ? 'duplicate' : resolved.issues.length ? 'needs_review' : 'ready',
    documentKind: kind,
    updatedAt: fresh,
  })
}
