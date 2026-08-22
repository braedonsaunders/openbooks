import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { convertOrder, ConversionError, type OrderKind } from '../../../lib/order-cycle'
import { computeOrderTotals, exactOrderMoney, exactOrderQuantity, loadOrder, orderTaxProfileMap, type OrderLineInput } from './lib'
import { cmp, normalizeMoney, toUnits } from '@openbooks/engine/src/money.ts'
import { compareDecimal } from '../../../lib/exact-decimal'
import { persistLineTaxComponents } from '../../../lib/bills'
import { segmentRegistry, validateExtraDims } from '../../../lib/segments'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../lib/features'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import {
  DocumentVoidError,
  requestDocumentVoid,
} from '@openbooks/engine/src/document-void.ts'

/**
 * Shared GET / PATCH / convert handlers for the three order-cycle modules.
 * Each module's route just binds its `kind` + read/create permission keys.
 *
 *   quote          → ar.read / ar.create
 *   sales_order    → ar.read / ar.create
 *   purchase_order → ap.read / ap.create
 */
export interface OrderHandlerConfig {
  kind: OrderKind
  readPerm: string
  createPerm: string
}

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

/** GET: full order payload (header + lines + links) scoped to the org. */
export function makeGET(cfg: OrderHandlerConfig) {
  return async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.readPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { id } = await params
    const order = await loadOrder(id, gate.user.orgId, cfg.kind)
    if (!order) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json(order)
  }
}

interface OrderPatchBody {
  partyId?: string | null
  documentDate?: string
  dueDate?: string | null
  memo?: string | null
  departmentId?: string | null
  projectId?: string | null
  subsidiaryId?: string | null
  extraDims?: Record<string, string | null>
  lines?: OrderLineInput[]
  status?: 'approved' | 'voided'
  reason?: string
  reversalDate?: string | null
}

/**
 * PATCH: draft autosave (header + full line replacement, totals recomputed) and
 * the draft→approved / →voided status transitions. Only draft orders are
 * editable; issuing requires a party + ≥1 line with a positive amount.
 */
export function makePATCH(cfg: OrderHandlerConfig) {
  return async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { user } = gate
    const { id } = await params

    const existing = (await db.execute<{ status: string; document_date: string }>(
      sql`select status, document_date from documents where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}`,
    ))
    if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const status = existing.rows[0].status

    const body = (await req.json()) as OrderPatchBody

    if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
      if (!(await subsidiaryFeatureEnabled(user.orgId))) {
        return NextResponse.json({ error: 'Subsidiaries are not enabled' }, { status: 422 })
      }
      if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(body.subsidiaryId)) {
        return NextResponse.json({ error: 'Subsidiary is not available' }, { status: 422 })
      }
      const subsidiary = (await db.execute(sql`
        select 1 from subsidiaries
         where id = ${body.subsidiaryId} and org_id = ${user.orgId}
           and is_active and not is_elimination
      `))
      if (!subsidiary.rows[0]) {
        return NextResponse.json({ error: 'Subsidiary is not available' }, { status: 422 })
      }
    }

    // --- status transitions ------------------------------------------------
    if (body.status) {
      if (body.status === 'approved') {
        if (status !== 'draft') {
          return NextResponse.json({ error: 'only a draft can be issued' }, { status: 422 })
        }
        const doc = (await db.execute<{ party_id: string | null; total: string }>(
          sql`select party_id, total from documents where id = ${id} and org_id = ${user.orgId}`,
        ))
        const d = doc.rows[0]!
        if (!d.party_id || cmp(d.total, '0') <= 0) {
          return NextResponse.json(
            { error: 'Add a party and at least one line before issuing' },
            { status: 422 },
          )
        }
        if (cfg.kind === 'sales_order') {
          const hold = (await db.execute<{ hold_reason: string | null }>(sql`
            select hold_reason
              from customer_roles
             where org_id = ${user.orgId} and party_id = ${d.party_id}
               and is_active and is_on_hold
             limit 1
          `))
          if (hold.rows[0]) {
            return NextResponse.json(
              {
                error: `customer is on credit hold${hold.rows[0].hold_reason ? ` — ${hold.rows[0].hold_reason}` : ''}`,
              },
              { status: 422 },
            )
          }
        }
        const submission = await submitAndReleaseIfUngated(cfg.kind, id, user.id)
        if (submission.flowError) {
          return NextResponse.json(
            { error: `approval could not be routed: ${submission.flowError}` },
            { status: 422 },
          )
        }
        if (submission.gated) {
          const order = await loadOrder(id, user.orgId, cfg.kind)
          return NextResponse.json(
            { ...order, approvalPending: true, requestId: submission.runId },
            { status: 202 },
          )
        }
      } else if (body.status === 'voided') {
        if (status === 'voided') {
          return NextResponse.json({ error: 'already voided' }, { status: 422 })
        }
        if (status !== 'approved') {
          return NextResponse.json(
            { error: 'only an issued order can be voided; discard a draft instead' },
            { status: 422 },
          )
        }
        try {
          const result = await requestDocumentVoid({
            documentId: id,
            orgId: user.orgId,
            actorId: user.id,
            reason: body.reason ?? '',
            reversalDate: body.reversalDate,
            source: 'ui',
          })
          if (result.status === 'pending_approval') {
            const order = await loadOrder(id, user.orgId, cfg.kind)
            return NextResponse.json(
              { ...order, voidPending: true, requestId: result.runId },
              { status: 202 },
            )
          }
        } catch (error) {
          if (error instanceof DocumentVoidError) {
            return NextResponse.json({ error: error.message }, { status: 422 })
          }
          throw error
        }
      }
      const order = await loadOrder(id, user.orgId, cfg.kind)
      return NextResponse.json(order)
    }

    // --- draft autosave ----------------------------------------------------
    if (status !== 'draft') {
      return NextResponse.json({ error: 'only draft orders can be edited' }, { status: 422 })
    }

    const segments = await segmentRegistry(user.orgId)
    const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
    if (headerDims && !headerDims.ok) {
      return NextResponse.json({ error: headerDims.error }, { status: 422 })
    }

    let totals: { subtotal: string; taxTotal: string; total: string } | null = null
    let preparedLines: (ReturnType<typeof computeOrderTotals>['lines'][number] & { extraDims: Record<string, string> })[] | null = null
    if (body.lines) {
      const valid: OrderLineInput[] = []
      for (const line of body.lines) {
        if (!(line.itemId || line.accountId)) continue
        const quantity = exactOrderQuantity(line.quantity ?? '0')
        const unitPrice = exactOrderMoney(line.unitPrice ?? '0')
        if (quantity === 'invalid' || unitPrice === 'invalid') {
          return NextResponse.json({ error: 'Order lines contain an invalid quantity or amount' }, { status: 422 })
        }
        try {
          toUnits(quantity)
        } catch {
          return NextResponse.json({ error: 'Order lines contain an invalid quantity or amount' }, { status: 422 })
        }
        if (compareDecimal(quantity, '0') > 0 && cmp(unitPrice, '0') >= 0) {
          valid.push({ ...line, quantity, unitPrice })
        }
      }
      const computed = computeOrderTotals(
        valid,
        await orderTaxProfileMap(user.orgId, body.documentDate ?? existing.rows[0].document_date),
      )
      totals = {
        subtotal: normalizeMoney(computed.subtotal),
        taxTotal: normalizeMoney(computed.taxTotal),
        total: normalizeMoney(computed.total),
      }
      preparedLines = []
      for (let i = 0; i < computed.lines.length; i++) {
        const l = computed.lines[i]!
        const lineDims = validateExtraDims(l.extraDims, segments)
        if (!lineDims.ok) {
          return NextResponse.json({ error: `Line ${i + 1}: ${lineDims.error}` }, { status: 422 })
        }
        preparedLines.push({
          ...l,
          quantity: l.quantity ?? '0',
          unitPrice: l.unitPrice ?? '0',
          amount: normalizeMoney(l.amount),
          taxInputAmount: normalizeMoney(l.taxInputAmount),
          taxAmount: normalizeMoney(l.taxAmount),
          extraDims: lineDims.cleaned,
        })
      }
      // Stored inventory / assembly / kit lines stay. Turning Inventory off
      // must 404 a write that would persist a new one of those kinds.
      if (!(await isFeatureEnabled(user.orgId, 'inventory'))) {
        const stored = (await db.execute<{ item_id: string }>(sql`
          select item_id from document_lines
           where org_id = ${user.orgId} and document_id = ${id} and item_id is not null`))
        const storedIds = new Set(stored.rows.map((row) => row.item_id))
        for (const l of preparedLines) {
          if (!l.itemId || storedIds.has(l.itemId)) continue
          const item = (await db.execute<{ kind: string }>(sql`
            select kind from items where id = ${l.itemId} and org_id = ${user.orgId}`))
          if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
            return NextResponse.json({ error: 'not found' }, { status: 404 })
          }
        }
      }
    }

    await db.transaction(async (tx) => {
      if (preparedLines) {
        await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${user.orgId}`)
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          const inserted = (await tx.execute<{ id: string }>(sql`
            insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
                                        quantity, unit, unit_price, amount, tax_code_id, tax_group_id,
                                        tax_input_amount, tax_amount,
                                        department_id, project_id, extra_dims)
            values (${user.orgId}, ${id}, ${i + 1}, ${l.itemId ?? null}, ${l.accountId ?? null},
                    ${l.description ?? null}, ${l.quantity ?? '0'}, ${l.unit ?? null}, ${l.unitPrice ?? '0'},
                    ${l.amount}, ${l.taxCodeId ?? null}, ${l.taxGroupId ?? null}, ${l.taxInputAmount}, ${l.taxAmount},
                    ${l.departmentId ?? null}, ${l.projectId ?? null}, ${JSON.stringify(l.extraDims)}::jsonb)
            returning id
          `))
          await persistLineTaxComponents(tx, {
            orgId: user.orgId,
            documentLineId: inserted.rows[0]!.id,
            components: l.taxComponents,
            actorId: user.id,
          })
        }
      }

      await tx.execute(sql`
        update documents set
          party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          due_date = ${body.dueDate !== undefined ? body.dueDate : sql`due_date`},
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          department_id = ${body.departmentId !== undefined ? body.departmentId : sql`department_id`},
          project_id = ${body.projectId !== undefined ? body.projectId : sql`project_id`},
          subsidiary_id = ${body.subsidiaryId !== undefined ? body.subsidiaryId : sql`subsidiary_id`},
          extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
          subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
          tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
          total = coalesce(${totals?.total ?? null}, total),
          updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
      `)
      const nextPartyId = body.partyId !== undefined ? body.partyId : null
      if (nextPartyId && (cfg.kind === 'quote' || cfg.kind === 'sales_order')) {
        await promoteCrmAccount(tx, {
          orgId: user.orgId,
          partyId: nextPartyId,
          actorId: user.id,
          toStage: cfg.kind === 'quote' ? 'prospect' : 'customer',
          sourceKind: cfg.kind,
          sourceId: id,
        })
      }
    })

    const order = await loadOrder(id, user.orgId, cfg.kind)
    return NextResponse.json(order)
  }
}

/**
 * DELETE: remove a non-posting order (doc/lines/links). deleteDocument throws
 * DeleteError → 422 if the order was converted downstream (has a document_link
 * to a posted doc).
 */
export function makeDELETE(cfg: OrderHandlerConfig) {
  return async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { user } = gate
    const { id } = await params
    const owned = (await db.execute(
      sql`select 1 from documents where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}`,
    ))
    if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    try {
      await deleteDocument(id, user.id, user.orgId)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
      throw e
    }
  }
}

/** POST convert: pull the order forward into `targetKind` via convertOrder(). */
export function makeConvertPOST(cfg: OrderHandlerConfig) {
  return async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { user } = gate
    const { id } = await params
    const body = (await req.json()) as { targetKind?: string }
    if (!body.targetKind) return NextResponse.json({ error: 'targetKind required' }, { status: 400 })

    // Scope check: the source must be this kind, in the caller's org.
    const owns = (await db.execute(
      sql`select 1 from documents where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}`,
    ))
    if (owns.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })

    try {
      const res = await convertOrder(user.orgId, user.id, id, body.targetKind)
      return NextResponse.json(res)
    } catch (e) {
      if (e instanceof ConversionError) {
        return NextResponse.json({ error: e.message }, { status: e.status })
      }
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
  }
}
