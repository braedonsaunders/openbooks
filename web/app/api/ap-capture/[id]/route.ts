import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getDocumentCaptureSettings } from '@openbooks/engine/src/ap-capture-config.ts'
import { normalizeCapturedDecimal, type CaptureLine, type NormalizedCapture } from '@openbooks/engine/src/ap-capture.ts'
import { resolveAndValidateCapture } from '@openbooks/engine/src/ap-capture-service.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function optionalText(value: unknown, max = 500): string | null {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, max) : null
}

function optionalUuid(value: unknown): string | null {
  const text = optionalText(value, 36)
  return text && UUID.test(text) ? text : null
}

function money(value: unknown, fallback: string | null = null): string | null {
  const normalized = normalizeCapturedDecimal(value)
  return normalized ?? fallback
}

function parseNormalized(raw: unknown): NormalizedCapture {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_capture')
  const row = raw as Record<string, unknown>
  const sourceLines = Array.isArray(row.lines) ? row.lines : []
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
  return NextResponse.json({ item: result.rows[0], fields: (fields as any).rows, events: (events as any).rows })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  let normalized: NormalizedCapture
  try {
    normalized = parseNormalized(body.normalized)
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
  const settings = await getDocumentCaptureSettings(gate.user.orgId)
  const resolved = await resolveAndValidateCapture({
    orgId: gate.user.orgId,
    captureItemId: id,
    normalized,
    confidenceThreshold: settings.confidenceThreshold,
    vendorId: body.vendorId === undefined ? undefined : optionalUuid(body.vendorId),
    purchaseOrderId: body.purchaseOrderId === undefined ? undefined : optionalUuid(body.purchaseOrderId),
  })
  const kind = body.documentKind === 'vendor_credit' ? 'vendor_credit' : 'vendor_bill'
  try {
    await db.transaction(async (tx) => {
    const locked = (await tx.execute<{ normalized: NormalizedCapture; status: string; document_kind: string; vendor_candidate_id: string | null; purchase_order_id: string | null }>(sql`
      select normalized, status, document_kind, vendor_candidate_id, purchase_order_id
        from ap_capture_items where org_id = ${gate.user.orgId} and id = ${id} for update
    `))
    const live = locked.rows[0]
    if (!live) throw new Error('capture_not_found')
    if (['materialized', 'rejected', 'extracting', 'queued'].includes(live.status)) throw new Error('capture_not_editable')
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
    await tx.execute(sql`
      update ap_capture_items set normalized = ${JSON.stringify(resolved.normalized)}::jsonb,
             validation_issues = ${JSON.stringify(resolved.issues)}::jsonb, status = ${status},
             document_kind = ${kind}, vendor_candidate_id = ${resolved.vendorId},
             purchase_order_id = ${resolved.purchaseOrderId}, assigned_to = ${gate.user.id},
             updated_at = now(), updated_by = ${gate.user.id}
       where org_id = ${gate.user.orgId} and id = ${id}
    `)
    await tx.execute(sql`
      insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
      values (${gate.user.orgId}, ${id}, 'review_saved',
              ${JSON.stringify({ status, issueCount: resolved.issues.length })}::jsonb, ${gate.user.id})
    `)
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'capture_not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    if (error instanceof Error && error.message === 'capture_not_editable') {
      return NextResponse.json({ error: 'not_editable' }, { status: 409 })
    }
    throw error
  }
  return NextResponse.json({
    normalized: resolved.normalized,
    validationIssues: resolved.issues,
    vendorId: resolved.vendorId,
    purchaseOrderId: resolved.purchaseOrderId,
    status: resolved.duplicate ? 'duplicate' : resolved.issues.length ? 'needs_review' : 'ready',
    documentKind: kind,
  })
}
