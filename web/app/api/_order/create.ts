import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/records/numbering.ts'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { isUuid } from '../../../lib/list-params'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../lib/features'
import type { OrderKind } from '../../../lib/order-kinds'
import { promoteCrmAccount } from '@openbooks/engine/src/crm/crm.ts'
import { persistLineTaxComponents } from "../../../lib/bills.ts";
import { activeStockLocations, profiledItemIds, resolveLineStockLocation } from '../../../lib/stock-locations'
import { segmentRegistry, validateExtraDims } from '../../../lib/segments'
import { orderCreateBody, parseJsonBody, type OrderCreateBody } from '@/lib/api/json'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../lib/api/idempotency'
import type { Authz } from '../../../lib/authz'
import {
  computeOrderTotals,
  exactOrderMoney,
  loadOrder,
  orderTaxProfileMap,
} from './lib'
import { resolveLinePriceBasis } from './line-selection'
import { selectPostableOrderLines, type OrderLineInput } from './line-selection'

/**
 * Shared collection-POST for the three order-cycle modules (quote /
 * sales_order / purchase_order). The unsaved-create drawer opens and cancels
 * with zero writes; its explicit Save lands here exactly once.
 *
 * The caller supplies a UUID idempotency key, which becomes the document ID:
 * retrying the same request returns the same order (exact replay 200)
 * without a duplicate insert, a second number, or a second audit event,
 * while reusing the key for a changed order — or a key minted in another
 * org — is a 409, never the older order returned as though it matched.
 * Replay compares only the canonical request-controlled match (derived
 * values such as the defaulted date, computed totals, resolved warehouses
 * and the allocated number are excluded), so an identical retry still
 * replays after midnight or a configuration change.
 *
 * The document number allocates INSIDE this save transaction (via the one
 * canonical allocator), so opening or cancelling the drawer burns neither a
 * row nor a sequence value. Creation always yields status=draft; issue,
 * convert, void and delete stay on the existing [id] routes, so lifecycle
 * semantics after persistence are unchanged.
 */

export interface OrderCreateConfig {
  kind: OrderKind
  createPerm: string
  numberPrefix: string
}

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

export function makePOST(cfg: OrderCreateConfig) {
  return async function POST(req: Request) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const parsedBody = await parseJsonBody(req, orderCreateBody)
    if (!parsedBody.ok) return parsedBody.response
    return createOrder(cfg, gate, req, parsedBody.data)
  }
}

/**
 * Unsaved-create kernel: idempotency-key check, domain validation, and the
 * single audited insert transaction. The typed body arrives pre-parsed
 * (orderCreateBody, enforced in the route); everything below is domain
 * refusal with a named remedy, never shape re-validation.
 */
export async function createOrder(
  cfg: OrderCreateConfig,
  gate: Authz,
  req: Request,
  body: OrderCreateBody,
) {
  const { user } = gate

  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }

  // Header dates land in DATE columns: an impossible calendar date
  // (2026-02-30) trips a raw storage 22008 failure instead of a domain
  // error, so refuse it here with the shared ISO calendar policy before
  // any further read or write. A null due date clears the field.
  if (body.documentDate !== undefined && !isIsoCalendarDate(body.documentDate)) {
    return bad('Document date must be a valid calendar date (YYYY-MM-DD)')
  }
  if (body.dueDate !== undefined && body.dueDate !== null && !isIsoCalendarDate(body.dueDate)) {
    return bad('Due date must be a valid calendar date (YYYY-MM-DD)')
  }

  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    if (!(await subsidiaryFeatureEnabled(user.orgId))) {
      return bad('Subsidiaries are not enabled')
    }
    if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(body.subsidiaryId)) {
      return bad(
        `subsidiary "${body.subsidiaryId}" is outside your visible subsidiaries — choose a subsidiary in scope or ask an administrator for access`,
      )
    }
    const subsidiary = (await db.execute(sql`
      select 1 from subsidiaries
       where id = ${body.subsidiaryId} and org_id = ${user.orgId}
         and is_active and not is_elimination
    `))
    if (!subsidiary.rows[0]) return bad('order subsidiary must be an active operating subsidiary of this organization')
  } else if (body.subsidiaryId === null && gate.allowedSubsidiaryIds) {
    return bad(
      'clearing the order subsidiary is not available with restricted subsidiary scope — choose a visible subsidiary instead',
    )
  }

  const segments = await segmentRegistry(user.orgId)
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) return bad(headerDims.error)

  // The order currency is the org's base currency — never invented. A
  // missing org row (or an unconfigured base currency) refuses by name
  // instead of silently booking foreign-currency intent as CAD.
  const orgRow = (await db.execute<{ base_currency: string | null }>(
    sql`select base_currency from orgs where id = ${user.orgId}`,
  ))
  const baseCurrency = orgRow.rows[0]?.base_currency
  if (!baseCurrency) {
    return bad('this organization has no base currency configured — set one before creating orders')
  }
  const currency = baseCurrency
  const documentDate = body.documentDate ?? (await businessToday(user.orgId))

  const profiles = await orderTaxProfileMap(user.orgId, documentDate)

  // Every referenced row must exist, be active, and belong to this org —
  // checked explicitly (batched per table) before the insert, never left
  // to a raw FK violation or a global uuid shape. Each refusal names the
  // reference and the remedy.
  const lines = body.lines ?? []
  {
    const ids = (values: (string | null | undefined)[]): string[] => [
      ...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)),
    ]
    const headerPartyIds = body.partyId ? [body.partyId] : []
    const headerDepartmentIds = body.departmentId ? [body.departmentId] : []
    const headerProjectIds = body.projectId ? [body.projectId] : []
    const lineItemIds = ids(lines.map((l) => l.itemId))
    const lineAccountIds = ids(lines.map((l) => l.accountId))
    const lineDepartmentIds = ids(lines.map((l) => l.departmentId))
    const lineProjectIds = ids(lines.map((l) => l.projectId))
    const activeIds = async (table: string, wanted: string[], extra = ''): Promise<Set<string>> => {
      if (wanted.length === 0) return new Set()
      const rows = (await db.execute<{ id: string }>(sql`
        select id from ${sql.identifier(table)}
         where org_id = ${user.orgId} and is_active ${sql.raw(extra)}
           and id = any(${`{${wanted.join(',')}}`}::uuid[])`)).rows
      return new Set(rows.map((r) => r.id))
    }
    const [parties, departments, projects, items, accounts] = await Promise.all([
      activeIds('parties', headerPartyIds),
      activeIds('departments', [...headerDepartmentIds, ...lineDepartmentIds]),
      activeIds('projects', [...headerProjectIds, ...lineProjectIds]),
      activeIds('items', lineItemIds),
      activeIds('accounts', lineAccountIds, 'and not is_summary'),
    ])
    if (body.partyId && !parties.has(body.partyId)) {
      return bad(`order party "${body.partyId}" must be an active party of this organization — choose an active party`)
    }
    if (body.departmentId && !departments.has(body.departmentId)) {
      return bad(`order department "${body.departmentId}" must be an active department of this organization`)
    }
    if (body.projectId && !projects.has(body.projectId)) {
      return bad(`order project "${body.projectId}" must be an active project of this organization`)
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const n = i + 1
      if (line.itemId && !items.has(line.itemId)) {
        return bad(`Order line ${n}: item "${line.itemId}" must be an active item of this organization`)
      }
      if (line.accountId && !accounts.has(line.accountId)) {
        return bad(`Order line ${n}: account "${line.accountId}" must be an active non-summary account of this organization`)
      }
      if (line.departmentId && !departments.has(line.departmentId)) {
        return bad(`Order line ${n}: department "${line.departmentId}" must be an active department of this organization`)
      }
      if (line.projectId && !projects.has(line.projectId)) {
        return bad(`Order line ${n}: project "${line.projectId}" must be an active project of this organization`)
      }
      // Tax profiles resolve through the effective-rate map: anything
      // missing is inactive, expired, or foreign — refused with its line.
      if (line.taxCodeId && !profiles.codes.has(line.taxCodeId)) {
        return bad(`Order line ${n}: tax code "${line.taxCodeId}" is inactive or has no effective rate for ${documentDate} — choose an active tax profile`)
      }
      if (line.taxGroupId && !profiles.groups.has(line.taxGroupId)) {
        return bad(`Order line ${n}: tax group "${line.taxGroupId}" is inactive or has no effective rate for ${documentDate} — choose an active tax profile`)
      }
    }
  }

  // The drawer's save shape: blank grid rows never persist, while any
  // populated row that cannot post refuses by line number (shared helper).
  const selected = selectPostableOrderLines(lines)
  if ('error' in selected) return bad(selected.error)
  const valid: OrderLineInput[] = selected.valid
  if (valid.length > 0) {
    const scope = {
      active: await activeStockLocations(user.orgId),
      profiled: await profiledItemIds(
        user.orgId,
        valid.map((line) => line.itemId).filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    }
    for (let i = 0; i < valid.length; i++) {
      const line = valid[i]!
      const resolved = resolveLineStockLocation(i + 1, line.itemId ?? null, line.stockLocationId, scope)
      if ('error' in resolved) return bad(resolved.error)
      line.stockLocationId = resolved.locationId
    }
  }
  let computed: ReturnType<typeof computeOrderTotals>
  try {
    computed = computeOrderTotals(valid, profiles)
  } catch (error) {
    return bad(error instanceof Error ? error.message : 'Order lines contain an invalid tax profile')
  }
  const subtotal = exactOrderMoney(computed.subtotal)
  const taxTotal = exactOrderMoney(computed.taxTotal)
  const total = exactOrderMoney(computed.total)
  if (subtotal === 'invalid' || taxTotal === 'invalid' || total === 'invalid') {
    return bad('Order totals contain an invalid amount')
  }
  const preparedLines: (Omit<(typeof computed.lines)[number], 'amount' | 'taxInputAmount' | 'taxAmount'> & {
    amount: string
    taxInputAmount: string
    taxAmount: string
    extraDims: Record<string, string>
  })[] = []
  for (let i = 0; i < computed.lines.length; i++) {
    const l = computed.lines[i]!
    const lineDims = validateExtraDims(l.extraDims, segments)
    if (!lineDims.ok) return bad(`Line ${i + 1}: ${lineDims.error}`)
    const amount = exactOrderMoney(l.amount)
    const taxInputAmount = exactOrderMoney(l.taxInputAmount)
    const taxAmount = exactOrderMoney(l.taxAmount)
    if (amount === 'invalid' || taxInputAmount === 'invalid' || taxAmount === 'invalid') {
      return bad('Order totals contain an invalid amount')
    }
    // Pricing provenance (0336): the drawer echoes the preview basis it
    // priced from; hand-priced lines carry none. A basis for a different
    // price is stale lineage and refuses instead of persisting.
    const priceBasis = resolveLinePriceBasis(i + 1, l.unitPrice, l.priceBasis)
    if (priceBasis !== null && 'error' in priceBasis) return bad(priceBasis.error)
    preparedLines.push({
      ...l,
      quantity: l.quantity ?? '0',
      unitPrice: l.unitPrice ?? '0',
      amount,
      taxInputAmount,
      taxAmount,
      extraDims: lineDims.cleaned,
      priceBasis,
    })
  }
  if (!(await isFeatureEnabled(user.orgId, 'inventory'))) {
    for (const l of preparedLines) {
      if (!l.itemId) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${l.itemId} and org_id = ${user.orgId}`))
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }

  // Idempotency, per the canonical contract (web/lib/api/idempotency.ts):
  // `match` is the request-controlled subset a retry must equal — derived
  // values (defaulted date, currency, computed totals, resolved warehouses,
  // the allocated number) are EXCLUDED, so an identical retry still replays
  // after midnight or a configuration change. `snapshot` is the full
  // immutable create image persisted in the insert audit event.
  const match: Record<string, unknown> = {
    party_id: body.partyId ?? null,
    due_date: body.dueDate ?? null,
    memo: body.memo ?? null,
    department_id: body.departmentId ?? null,
    project_id: body.projectId ?? null,
    subsidiary_id: body.subsidiaryId ?? null,
    extra_dims: body.extraDims ?? {},
    lines: lines.map((l) => ({
      item_id: l.itemId ?? null,
      account_id: l.accountId ?? null,
      description: l.description ?? null,
      quantity: l.quantity ?? null,
      unit: l.unit ?? null,
      unit_price: l.unitPrice ?? null,
      tax_code_id: l.taxCodeId ?? null,
      tax_group_id: l.taxGroupId ?? null,
      department_id: l.departmentId ?? null,
      project_id: l.projectId ?? null,
      stock_location_id: l.stockLocationId ?? null,
      extra_dims: l.extraDims ?? {},
    })),
  }
  if (body.documentDate !== undefined) match.document_date = body.documentDate
  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    kind: cfg.kind,
    ...match,
    document_date: documentDate,
    currency,
    subtotal,
    tax_total: taxTotal,
    total,
    status: 'draft',
  }

  const isTenantReferenceViolation = (error: unknown): boolean => {
    let cursor: unknown = error
    for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === 'object'; depth++) {
      if ((cursor as { code?: unknown }).code === '23503') return true
      cursor = (cursor as { cause?: unknown }).cause
    }
    return false
  }

  let replayed = false
  try {
    const outcome = await db.transaction(async (tx) => {
      // Same-key fence first: two concurrent first-Saves with one
      // idempotency key must serialize so the loser replays (200) instead
      // of racing past the prior-row check and dying on the insert
      // conflict (409). Scoped to the key alone — never blocks other keys.
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`)
      // The lookup never reads another org's row: a key minted elsewhere
      // misses here, hits the insert conflict below, and refuses as 409.
      if ((await claimIdempotentCreate(tx, { orgId: user.orgId, table: 'documents', key: requestId })) === 'exists') {
        // Compared against the immutable create snapshot in the insert
        // audit event — not today's row — so an unchanged retry still
        // succeeds even when a later PATCH has legitimately edited it.
        const verdict = await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: 'documents',
          key: requestId,
          match,
        })
        if (verdict !== 'replay') throw new Error('idempotency_key_conflict')
        return { replayed: true }
      }
      // The number allocates HERE, inside the successful save transaction:
      // opening or cancelling the drawer never reaches this statement, so
      // neither burns a row nor a sequence value. The allocator serializes
      // concurrent savers on the org-wide counter row.
      const documentNumber = await allocateDocumentNumber(tx, user.orgId, cfg.kind, cfg.numberPrefix)
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, document_date, due_date,
           currency, status, subsidiary_id, department_id, project_id,
           extra_dims, memo, subtotal, tax_total, total, created_by, updated_by)
        values
          (${requestId}, ${user.orgId}, ${cfg.kind}, ${documentNumber},
           ${body.partyId ?? null}, ${documentDate}, ${body.dueDate ?? null},
           ${currency}, 'draft', ${body.subsidiaryId ?? null},
           ${body.departmentId ?? null}, ${body.projectId ?? null},
           ${JSON.stringify(headerDims ? headerDims.cleaned : {})}::jsonb,
           ${body.memo ?? null}, ${subtotal}, ${taxTotal}, ${total},
           ${user.id}, ${user.id})
        on conflict (id) do nothing
        returning id
      `))
      if (!inserted.rows[0]) throw new Error('idempotency_key_conflict')
      for (let i = 0; i < preparedLines.length; i++) {
        const l = preparedLines[i]!
        const lineId = (await tx.execute<{ id: string }>(sql`
          insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
                                      quantity, unit, unit_price, amount, tax_code_id, tax_group_id,
                                      tax_input_amount, tax_amount,
                                      department_id, project_id, stock_location_id, extra_dims, price_basis)
          values (${user.orgId}, ${requestId}, ${i + 1}, ${l.itemId ?? null}, ${l.accountId ?? null},
                  ${l.description ?? null}, ${l.quantity ?? '0'}, ${l.unit ?? null}, ${l.unitPrice ?? '0'},
                  ${l.amount}, ${l.taxCodeId ?? null}, ${l.taxGroupId ?? null}, ${l.taxInputAmount}, ${l.taxAmount},
                  ${l.departmentId ?? null}, ${l.projectId ?? null}, ${l.stockLocationId ?? null}, ${JSON.stringify(l.extraDims)}::jsonb,
                  ${l.priceBasis == null ? null : JSON.stringify(l.priceBasis)}::jsonb)
          returning id
        `))
        await persistLineTaxComponents(tx, {
          orgId: user.orgId,
          documentLineId: lineId.rows[0]!.id,
          components: l.taxComponents,
          actorId: user.id,
        })
      }
      const nextPartyId = body.partyId ?? null
      if (nextPartyId && (cfg.kind === 'quote' || cfg.kind === 'sales_order')) {
        const promotion = await promoteCrmAccount(tx, {
          orgId: user.orgId,
          partyId: nextPartyId,
          actorId: user.id,
          toStage: cfg.kind === 'quote' ? 'prospect' : 'customer',
          sourceKind: cfg.kind,
          sourceId: requestId,
        })
        // A sales order makes the party a customer: core AR state the credit
        // checks below depend on. A quote only touches CRM lifecycle, which
        // is legitimately absent with CRM off.
        if (cfg.kind === 'sales_order' && !promotion.customerRoleActive) {
          throw new Error('customer role was not established while issuing the sales order')
        }
      }
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${user.orgId}, 'documents', ${requestId}, 'insert',
           ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
           ${user.id}, ${requestId})
      `)
      return { replayed: false }
    })
    replayed = outcome.replayed
  } catch (error) {
    const message = error instanceof Error
      ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
      : String(error)
    if (message.includes('idempotency_key_conflict')) {
      return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
    }
    if (isTenantReferenceViolation(error)) {
      return bad('Referenced party, account, tax profile, or dimension must belong to this organization')
    }
    throw error
  }

  const order = await loadOrder(requestId, user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
  if (!order) return bad('save_failed', 500)
  return NextResponse.json(order, { status: replayed ? 200 : 201 })
}
