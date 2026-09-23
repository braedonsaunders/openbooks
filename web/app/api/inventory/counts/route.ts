import { exactMoney, isoDate, nullableUuidId, parseJsonBody, uuidId } from "@/lib/api/json";
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  cancelStockCount,
  createStockCount,
  postStockCount,
  recordCountedQuantity,
  recountStockCountLine,
  returnStockCountToCounting,
  setStockCountDate,
  startStockCount,
  submitStockCountForReview,
} from '@openbooks/engine/src/inventory/stock-counts.ts'
import { getStockCountDetail, listStockCounts } from '@openbooks/engine/src/inventory/stock-count-queries.ts'
import { executeIdempotentInventoryAction } from '@openbooks/engine/src/inventory/action-idempotency.ts'
import {
  InventoryError,
  InventoryIdempotencyConflictError,
  InventoryOwnershipError,
} from '@openbooks/engine/src/inventory/contracts.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

const countLineBody = z.looseObject({
  itemId: uuidId,
  stockLocationId: uuidId,
  lotId: nullableUuidId.optional(),
})

const stockCountBody = z.looseObject({
  action: z.enum(['create', 'start', 'record', 'recount', 'submit', 'return', 'setDate', 'post', 'cancel']),
  idempotencyKey: z.string().optional(),
  countId: uuidId.optional(),
  lineId: uuidId.optional(),
  locationId: uuidId.optional(),
  subsidiaryId: uuidId.optional(),
  date: isoDate().optional(),
  countedQuantity: exactMoney().optional(),
  memo: z.string().nullable().optional(),
  lines: z.array(countLineBody).optional(),
})

function inventoryStatus(e: unknown): number {
  if (e instanceof InventoryOwnershipError) return 403
  if (e instanceof InventoryIdempotencyConflictError) return 409
  if (e instanceof InventoryError) return 422
  return 500
}

function refusal(e: unknown) {
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: inventoryStatus(e) })
}

/**
 * Cycle-count reader: the org's counts newest-first, or one count with its
 * lines when ?id= is given. Mirrors the counts page server loader.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('items.read')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  if (!(await isFeatureEnabled(user.orgId, 'inventory'))) {
    return NextResponse.json({ error: 'feature disabled' }, { status: 404 })
  }
  try {
    const params = new URL(req.url).searchParams
    const id = params.get('id')
    if (id) {
      if (!isUuid(id)) return NextResponse.json({ error: 'count required' }, { status: 422 })
      // Fence restricted callers against the count's own subsidiary, resolved
      // server-side from the row — the same shape as the movement reversal
      // fence, because the subsidiary lives on the count, not the request.
      const scope = await db.execute<{ subsidiary_id: string }>(
        sql`select subsidiary_id from stock_counts where id = ${id} and org_id = ${user.orgId}`,
      )
      const subsidiaryId = scope.rows[0]?.subsidiary_id ?? null
      if (gate.allowedSubsidiaryIds && (!subsidiaryId || !gate.allowedSubsidiaryIds.has(subsidiaryId))) {
        return NextResponse.json({ error: 'subsidiary not permitted' }, { status: 403 })
      }
      return NextResponse.json({ ok: true, ...(await getStockCountDetail(user.orgId, id)) })
    }
    // Pages are cursor-bounded — count #501+ is reachable, never truncated.
    const limitParam = params.get('limit')
    let limit: number | undefined
    if (limitParam !== null) {
      limit = Number(limitParam)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return NextResponse.json({ error: 'limit must be an integer between 1 and 500' }, { status: 422 })
      }
    }
    const page = await listStockCounts(user.orgId, {
      limit,
      cursor: params.get('cursor'),
    })
    return NextResponse.json({ ok: true, ...page })
  } catch (e: unknown) {
    return refusal(e)
  }
}

/**
 * Stock-count lifecycle writes. Every mutation is monetary evidence on the
 * way to posting, so each request MUST carry a stable `idempotencyKey` and
 * executes through the engine's canonical idempotency boundary — the same
 * contract as the inventory actions route: same key + payload replays,
 * key reuse with different input conflicts (409), missing/invalid key fails
 * closed (422). Posting defaults its key to the count itself, so two
 * operators racing the same Post serialize instead of double-applying.
 *
 * Variances post through adjustInventory — the existing movement path — so
 * counts inherit its costing, closed-period fence, and balanced journals.
 * Authority is items.post for every write: counting is the first half of a
 * stock-moving, journal-carrying act.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, stockCountBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (!body.action) return NextResponse.json({ error: 'invalid action' }, { status: 422 })
  const gate = await guardPermission('items.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const allowedSubsidiaryIds = gate.allowedSubsidiaryIds
  if (!(await isFeatureEnabled(user.orgId, 'inventory'))) {
    return NextResponse.json({ error: 'feature disabled' }, { status: 404 })
  }

  async function countSubsidiary(countId: string): Promise<string | null> {
    const r = await db.execute<{ subsidiary_id: string }>(
      sql`select subsidiary_id from stock_counts where id = ${countId} and org_id = ${user.orgId}`,
    )
    return r.rows[0]?.subsidiary_id ?? null
  }

  async function fenceCount(countId: string): Promise<NextResponse | null> {
    const subsidiaryId = await countSubsidiary(countId)
    if (!subsidiaryId) return NextResponse.json({ error: 'count not found in this organization' }, { status: 422 })
    if (allowedSubsidiaryIds && !allowedSubsidiaryIds.has(subsidiaryId)) {
      return NextResponse.json({ error: 'subsidiary not permitted' }, { status: 403 })
    }
    return null
  }

  try {
    if (body.action === 'create') {
      if (!body.locationId || !isUuid(body.locationId)) {
        return NextResponse.json({ error: 'location required' }, { status: 422 })
      }
      if (!body.lines || body.lines.length === 0) {
        return NextResponse.json({ error: 'at least one count line required' }, { status: 422 })
      }
      // Default to the org's primary/first subsidiary, exactly as the
      // inventory actions route does when the caller scopes none.
      let subsidiaryId = body.subsidiaryId
      if (subsidiaryId === undefined) {
        const r = (await db.execute<{ id: string }>(
          sql`select id from subsidiaries where org_id = ${user.orgId} order by created_at, id limit 1`,
        ))
        subsidiaryId = r.rows[0]?.id
        if (!subsidiaryId) return NextResponse.json({ error: 'no subsidiary configured' }, { status: 422 })
      }
      if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
        return NextResponse.json({ error: 'subsidiary not permitted' }, { status: 403 })
      }
      if (!body.date) return NextResponse.json({ error: 'count date required' }, { status: 422 })
      const input = {
        locationId: body.locationId,
        subsidiaryId,
        countedOn: body.date,
        memo: body.memo ?? null,
        lines: body.lines.map((l) => ({
          itemId: l.itemId!,
          stockLocationId: l.stockLocationId!,
          lotId: l.lotId ?? null,
        })),
      }
      const { value: res, replayed } = await executeIdempotentInventoryAction(
        user.orgId,
        user.id,
        {
          operation: 'inventory.stock-count.create',
          idempotencyKey: body.idempotencyKey,
          request: input,
          execute: () => createStockCount(user.orgId, user.id, input),
        },
      )
      return NextResponse.json({ ok: true, replayed, ...res })
    }

    if (!body.countId || !isUuid(body.countId)) {
      return NextResponse.json({ error: 'count required' }, { status: 422 })
    }
    const countId = body.countId
    const fence = await fenceCount(countId)
    if (fence) return fence

    const keyed = async <T>(operation: string, request: unknown, execute: () => Promise<T>) => {
      const { value, replayed } = await executeIdempotentInventoryAction(user.orgId, user.id, {
        operation,
        idempotencyKey: body.idempotencyKey,
        request,
        execute,
      })
      return { ok: true, replayed, ...(value as Record<string, unknown>) }
    }

    switch (body.action) {
      case 'start':
        return NextResponse.json(
          await keyed('inventory.stock-count.start', { countId }, () => startStockCount(user.orgId, user.id, countId)),
        )
      case 'record': {
        if (!body.lineId || !isUuid(body.lineId)) {
          return NextResponse.json({ error: 'count line required' }, { status: 422 })
        }
        if (body.countedQuantity === undefined) {
          return NextResponse.json({ error: 'counted quantity required' }, { status: 422 })
        }
        const input = { countId, lineId: body.lineId, countedQuantity: body.countedQuantity }
        return NextResponse.json(
          await keyed('inventory.stock-count.record', input, () =>
            recordCountedQuantity(user.orgId, user.id, input),
          ),
        )
      }
      case 'recount': {
        if (!body.lineId || !isUuid(body.lineId)) {
          return NextResponse.json({ error: 'count line required' }, { status: 422 })
        }
        const input = { countId, lineId: body.lineId }
        return NextResponse.json(
          await keyed('inventory.stock-count.recount', input, () =>
            recountStockCountLine(user.orgId, user.id, input),
          ),
        )
      }
      case 'submit':
        return NextResponse.json(
          await keyed('inventory.stock-count.submit', { countId }, () =>
            submitStockCountForReview(user.orgId, user.id, countId),
          ),
        )
      case 'return':
        return NextResponse.json(
          await keyed('inventory.stock-count.return', { countId }, () =>
            returnStockCountToCounting(user.orgId, user.id, countId),
          ),
        )
      case 'setDate': {
        if (!body.date) return NextResponse.json({ error: 'count date required' }, { status: 422 })
        const input = { countId, countedOn: body.date }
        return NextResponse.json(
          await keyed('inventory.stock-count.set-date', input, () => setStockCountDate(user.orgId, user.id, input)),
        )
      }
      case 'post': {
        // Posting defaults its key to the count itself: two operators racing
        // the same Post share one claim and serialize (replay/conflict),
        // never double-apply. An explicit client key still wins when given.
        const { value: res, replayed } = await executeIdempotentInventoryAction(user.orgId, user.id, {
          operation: 'inventory.stock-count.post',
          idempotencyKey: body.idempotencyKey ?? `stock-count-post:${countId}`,
          request: { countId },
          execute: () => postStockCount(user.orgId, user.id, countId),
        })
        return NextResponse.json({ ok: true, replayed, ...res })
      }
      case 'cancel':
        return NextResponse.json(
          await keyed('inventory.stock-count.cancel', { countId }, () => cancelStockCount(user.orgId, user.id, countId)),
        )
      default:
        return NextResponse.json({ error: 'invalid action' }, { status: 422 })
    }
  } catch (e: unknown) {
    return refusal(e)
  }
}
