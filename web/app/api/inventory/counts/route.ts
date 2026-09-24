import { exactMoney, isoDate, nullableUuidId, parseJsonBody, uuidId } from "@/lib/api/json";
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
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
import { InventoryError, InventoryOwnershipError } from '@openbooks/engine/src/inventory/contracts.ts'
import { inventoryErrorStatus } from '@/lib/api/inventory-errors'
import { SubsidiaryError, defaultPostingSubsidiaryId, loadSubsidiaryContext } from '@openbooks/engine/src/organization/subsidiaries.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

const countLineBody = z.looseObject({
  itemId: z.string().optional(),
  stockLocationId: z.string().optional(),
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

function refusal(e: unknown) {
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: inventoryErrorStatus(e) })
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
      // The detail rechecks the scope under the count lock inside its own
      // snapshot: the probe above is a fast path only.
      return NextResponse.json({ ok: true, ...(await getStockCountDetail(user.orgId, id, gate.allowedSubsidiaryIds)) })
    }
    // The list is subsidiary-scoped server-side: a restricted caller sees
    // only the entities in their grant, and an empty grant sees nothing.
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
      subsidiaryIds: gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : null,
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

  /**
   * Locked recheck inside the write transaction: the fenceCount probe above
   * can authorize count A while a concurrent A→B reassignment lands before
   * the service commits (the service joins this transaction, so the lock
   * covers its whole unit — including retries). Throws the same
   * inventory-domain refusals the probe answers with.
   */
  async function lockedCountFence(countId: string): Promise<void> {
    const r = await db.execute<{ subsidiary_id: string }>(
      sql`select subsidiary_id from stock_counts where id = ${countId} and org_id = ${user.orgId} for update`,
    )
    const subsidiaryId = r.rows[0]?.subsidiary_id ?? null
    if (!subsidiaryId) throw new InventoryError('count not found in this organization')
    if (allowedSubsidiaryIds && !allowedSubsidiaryIds.has(subsidiaryId)) {
      throw new InventoryOwnershipError('subsidiary not permitted')
    }
  }

  try {
    if (body.action === 'create') {
      if (!body.locationId || !isUuid(body.locationId)) {
        return NextResponse.json({ error: 'location required' }, { status: 422 })
      }
      if (!body.lines || body.lines.length === 0) {
        return NextResponse.json({ error: 'at least one count line required' }, { status: 422 })
      }
      // An unscoped count books to the hierarchy root through the shared
      // default-entity resolver — the same default the document path applies.
      let subsidiaryId = body.subsidiaryId
      if (subsidiaryId === undefined) {
        try {
          subsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, user.orgId))
        } catch (e) {
          if (!(e instanceof SubsidiaryError)) throw e
          return NextResponse.json({ error: 'no subsidiary configured' }, { status: 422 })
        }
      }
      if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
        return NextResponse.json({ error: 'subsidiary not permitted' }, { status: 403 })
      }
      if (!body.date) return NextResponse.json({ error: 'count date required' }, { status: 422 })
      // Partly filled lines are refused by row, naming the missing field —
      // the client pins the same message to the row; direct API callers get
      // it here instead of a schema-shaped refusal.
      for (let i = 0; i < body.lines.length; i += 1) {
        const line = body.lines[i]!
        if (!line.itemId) {
          return NextResponse.json({ error: `Line ${i + 1}: choose an item` }, { status: 422 })
        }
        if (!isUuid(line.itemId)) {
          return NextResponse.json({ error: `Line ${i + 1}: invalid item id` }, { status: 422 })
        }
        if (!line.stockLocationId) {
          return NextResponse.json({ error: `Line ${i + 1}: choose a stock location` }, { status: 422 })
        }
        if (!isUuid(line.stockLocationId)) {
          return NextResponse.json({ error: `Line ${i + 1}: invalid stock location id` }, { status: 422 })
        }
      }
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
      // The whole unit — locked recheck plus the idempotent service call,
      // which joins this transaction — commits atomically, so a concurrent
      // reassignment blocks on the count lock instead of slipping between
      // the fenceCount probe and the service write.
      const { value, replayed } = await withOrgTransaction(user.orgId, async () => {
        await lockedCountFence(countId)
        return executeIdempotentInventoryAction(user.orgId, user.id, {
          operation,
          idempotencyKey: body.idempotencyKey,
          request,
          execute,
        })
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
        const input = { countId, lineId: body.lineId, countedQuantity: body.countedQuantity, reason: body.memo ?? null }
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
        const input = { countId, lineId: body.lineId, reason: body.memo ?? null }
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
        // Like keyed() above, the locked recheck and the post join one
        // transaction so a reassignment cannot slip between them.
        const { value: res, replayed } = await withOrgTransaction(user.orgId, async () => {
          await lockedCountFence(countId)
          return executeIdempotentInventoryAction(user.orgId, user.id, {
            operation: 'inventory.stock-count.post',
            idempotencyKey: body.idempotencyKey ?? `stock-count-post:${countId}`,
            request: { countId },
            execute: () => postStockCount(user.orgId, user.id, countId),
          })
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
