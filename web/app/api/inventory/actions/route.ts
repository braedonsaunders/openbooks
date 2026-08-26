import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney, toUnits } from '@openbooks/engine/src/money.ts'
import {
  adjustInventory,
  buildAssembly,
  executeIdempotentInventoryAction,
  issueInventory,
  postLandedCostVoucher,
  receiveInventory,
  reverseInventoryMovement,
  transferInventory,
  InventoryError,
  InventoryIdempotencyConflictError,
  InventoryOwnershipError,
} from '@openbooks/engine/src/inventory.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { INVENTORY_ACTION_PERMISSIONS, type CataloguePermission } from '@openbooks/engine/src/permissions.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Body {
  action?: 'receive' | 'issue' | 'adjust' | 'transfer' | 'build' | 'landed' | 'reverse'
  /** Stable retry identity; required — replay safety is enforced by the engine. */
  idempotencyKey?: string
  movementId?: string
  itemId?: string
  stockLocationId?: string
  toStockLocationId?: string
  quantity?: string
  unitCost?: string
  offsetAccountId?: string
  basis?: 'value' | 'quantity'
  subsidiaryId?: string
  date?: string
  memo?: string
  lotId?: string
  serialId?: string
}

function num(v: unknown): string | null {
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return null
  return normalizeMoney(exact)
}

/**
 * Post an inventory movement through the kernel: receive (DR inventory / CR
 * offset), issue (DR COGS / CR inventory), or adjust (± vs the adjustment
 * account). Costing follows the item's profile.
 *
 * Every action is monetary, so each request MUST carry a stable
 * `idempotencyKey` and is executed through the engine's canonical idempotency
 * boundary: the same key + payload replays the stored result (serially and
 * concurrently) with exactly one accounting unit, key reuse with different
 * input conflicts (409), and a missing/invalid key fails closed (422).
 *
 * Each action is gated by its own authority from INVENTORY_ACTION_PERMISSIONS:
 * value-carrying movements demand the items.post monetary grant and reversal
 * demands items.reverse, so catalog maintenance never confers ledger power.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  const permission: CataloguePermission | undefined = (
    INVENTORY_ACTION_PERMISSIONS as Record<string, CataloguePermission | undefined>
  )[body?.action as string]
  if (!body.action || !permission) {
    return NextResponse.json({ error: 'invalid action' }, { status: 422 })
  }
  const gate = await guardPermission(permission)
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  if (!(await isFeatureEnabled(user.orgId, 'inventory'))) {
    return NextResponse.json({ error: 'feature disabled' }, { status: 404 })
  }

  if (body.action === 'reverse') {
    if (!body.movementId || !isUuid(body.movementId)) {
      return NextResponse.json({ error: 'movement required' }, { status: 422 })
    }
    if (!body.date || !DATE_RE.test(body.date)) {
      return NextResponse.json({ error: 'reversal date required' }, { status: 422 })
    }
    if (typeof body.memo !== 'string' || body.memo.trim().length < 5 || body.memo.trim().length > 500) {
      return NextResponse.json({ error: 'reversal reason must be between 5 and 500 characters' }, { status: 422 })
    }
    // The movement's subsidiary lives on the row, not in the request, so
    // resolve it server-side and fence restricted callers before any unwind.
    const source = await db.execute<{ subsidiary_id: string | null }>(
      sql`select subsidiary_id from inventory_movements where id = ${body.movementId} and org_id = ${user.orgId}`,
    )
    const movementSubsidiaryId = source.rows[0]?.subsidiary_id ?? null
    if (gate.allowedSubsidiaryIds && (!movementSubsidiaryId || !gate.allowedSubsidiaryIds.has(movementSubsidiaryId))) {
      return NextResponse.json({ error: 'subsidiary not permitted' }, { status: 403 })
    }
    try {
      const { value: res, replayed } = await executeIdempotentInventoryAction(
        user.orgId,
        user.id,
        {
          operation: 'inventory.reverse',
          idempotencyKey: body.idempotencyKey,
          request: {
            movementId: body.movementId,
            reversalDate: body.date,
            reason: body.memo,
          },
          execute: () =>
            reverseInventoryMovement(user.orgId, user.id, {
              movementId: body.movementId!,
              reversalDate: body.date!,
              reason: body.memo!,
            }),
        },
      )
      return NextResponse.json({ ok: true, replayed, ...res })
    } catch (e: unknown) {
      const status =
        e instanceof InventoryOwnershipError
          ? 403
          : e instanceof InventoryIdempotencyConflictError
            ? 409
            : e instanceof InventoryError
              ? 422
              : 500
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status })
    }
  }
  if (!body.itemId || !isUuid(body.itemId)) return NextResponse.json({ error: 'item required' }, { status: 422 })
  if (!body.stockLocationId || !isUuid(body.stockLocationId)) {
    return NextResponse.json({ error: 'stock location required' }, { status: 422 })
  }
  const quantity = num(body.quantity)
  if (quantity === null || toUnits(quantity) === 0n) {
    return NextResponse.json({ error: 'quantity required' }, { status: 422 })
  }
  const date = body.date && DATE_RE.test(body.date) ? body.date : await businessToday(user.orgId)

  // Default to the org's primary/first subsidiary when the caller didn't scope one.
  let subsidiaryId = body.subsidiaryId
  if (!subsidiaryId || !isUuid(subsidiaryId)) {
    const r = (await db.execute<{ id: string }>(
      sql`select id from subsidiaries where org_id = ${user.orgId} order by created_at limit 1`,
    ))
    subsidiaryId = r.rows[0]?.id
    if (!subsidiaryId) return NextResponse.json({ error: 'no subsidiary configured' }, { status: 422 })
  }
  if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
    return NextResponse.json({ error: 'subsidiary not permitted' }, { status: 403 })
  }

  try {
    if (body.action === 'receive') {
      const unitCost = num(body.unitCost)
      if (unitCost === null) return NextResponse.json({ error: 'unit cost required' }, { status: 422 })
      if (!body.offsetAccountId || !isUuid(body.offsetAccountId)) {
        return NextResponse.json({ error: 'offset account required' }, { status: 422 })
      }
      const input = {
        itemId: body.itemId,
        stockLocationId: body.stockLocationId,
        quantity,
        unitCost,
        subsidiaryId,
        offsetAccountId: body.offsetAccountId,
        date,
        lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
        serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
        memo: body.memo ?? null,
      }
      const { value: res, replayed } = await executeIdempotentInventoryAction(
        user.orgId,
        user.id,
        {
          operation: 'inventory.receive',
          idempotencyKey: body.idempotencyKey,
          request: input,
          execute: () => receiveInventory(user.orgId, user.id, input),
        },
      )
      return NextResponse.json({ ok: true, replayed, ...res })
    }
    if (body.action === 'build') {
      const input = {
        assemblyItemId: body.itemId,
        quantity,
        stockLocationId: body.stockLocationId,
        subsidiaryId,
        date,
        memo: body.memo ?? null,
      }
      const { value: res, replayed } = await executeIdempotentInventoryAction(
        user.orgId,
        user.id,
        {
          operation: 'inventory.build',
          idempotencyKey: body.idempotencyKey,
          request: input,
          execute: () => buildAssembly(user.orgId, user.id, input),
        },
      )
      return NextResponse.json({ ok: true, replayed, ...res })
    }
    if (body.action === 'landed') {
      if (!body.offsetAccountId || !isUuid(body.offsetAccountId)) {
        return NextResponse.json({ error: 'freight account required' }, { status: 422 })
      }
      const basis = body.basis === 'quantity' ? ('quantity' as const) : ('value' as const)
      const { value: res, replayed } = await executeIdempotentInventoryAction(
        user.orgId,
        user.id,
        {
          operation: 'inventory.landed',
          idempotencyKey: body.idempotencyKey,
          request: {
            amount: quantity,
            basis,
            freightAccountId: body.offsetAccountId,
            subsidiaryId,
            voucherDate: date,
            memo: body.memo ?? null,
            targets: [{ itemId: body.itemId, stockLocationId: body.stockLocationId }],
          },
          execute: () =>
            postLandedCostVoucher(user.orgId, user.id, {
              amount: quantity,
              basis,
              freightAccountId: body.offsetAccountId!,
              subsidiaryId,
              voucherDate: date,
              memo: body.memo ?? null,
              targets: [{ itemId: body.itemId!, stockLocationId: body.stockLocationId! }],
            }),
        },
      )
      return NextResponse.json({
        ok: true,
        replayed,
        id: res.id,
        documentNumber: res.documentNumber,
        entryId: res.entryId,
        value: quantity,
      })
    }
    if (body.action === 'transfer') {
      if (!body.toStockLocationId || !isUuid(body.toStockLocationId)) {
        return NextResponse.json({ error: 'destination location required' }, { status: 422 })
      }
      const input = {
        itemId: body.itemId,
        fromStockLocationId: body.stockLocationId,
        toStockLocationId: body.toStockLocationId,
        quantity,
        lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
        serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
        subsidiaryId,
        date,
        memo: body.memo ?? null,
      }
      const { value: res, replayed } = await executeIdempotentInventoryAction(
        user.orgId,
        user.id,
        {
          operation: 'inventory.transfer',
          idempotencyKey: body.idempotencyKey,
          request: input,
          execute: () => transferInventory(user.orgId, user.id, input),
        },
      )
      return NextResponse.json({ ok: true, replayed, ...res })
    }
    if (body.action === 'issue') {
      const input = {
        itemId: body.itemId,
        stockLocationId: body.stockLocationId,
        quantity,
        subsidiaryId,
        offsetAccountId:
          body.offsetAccountId && isUuid(body.offsetAccountId) ? body.offsetAccountId : undefined,
        date,
        lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
        serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
        memo: body.memo ?? null,
      }
      const { value: res, replayed } = await executeIdempotentInventoryAction(
        user.orgId,
        user.id,
        {
          operation: 'inventory.issue',
          idempotencyKey: body.idempotencyKey,
          request: input,
          execute: () => issueInventory(user.orgId, user.id, input),
        },
      )
      return NextResponse.json({ ok: true, replayed, ...res })
    }
    // adjust: quantity is a signed delta
    const input = {
      itemId: body.itemId,
      stockLocationId: body.stockLocationId,
      quantityDelta: quantity,
      lotId: body.lotId && isUuid(body.lotId) ? body.lotId : undefined,
      serialId: body.serialId && isUuid(body.serialId) ? body.serialId : undefined,
      subsidiaryId,
      date,
      unitCost: num(body.unitCost) ?? undefined,
      memo: body.memo ?? null,
    }
    const { value: res, replayed } = await executeIdempotentInventoryAction(
      user.orgId,
      user.id,
      {
        operation: 'inventory.adjust',
        idempotencyKey: body.idempotencyKey,
        request: input,
        execute: () => adjustInventory(user.orgId, user.id, input),
      },
    )
    return NextResponse.json({ ok: true, replayed, ...res })
  } catch (e: unknown) {
    // A cross-entity inventory attempt is refused as an authorization
    // failure, mirroring the subsidiary permission gate above; key reuse
    // with different input is a conflict, not a validation miss.
    const status =
      e instanceof InventoryOwnershipError
        ? 403
        : e instanceof InventoryIdempotencyConflictError
          ? 409
          : e instanceof InventoryError
            ? 422
            : 500
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status })
  }
}
