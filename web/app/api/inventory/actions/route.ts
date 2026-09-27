import { apiErrorResponse } from '@/lib/api/error-response'
import { exactMoney, isoDate, nullableUuidId, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { toUnits } from '@openbooks/engine/src/money/money.ts'
import { adjustInventory, issueInventory, receiveInventory } from "@openbooks/engine/src/inventory/movements.ts";
import { buildAssembly, reverseAssemblyBuild } from "@openbooks/engine/src/inventory/assembly.ts";
import { executeIdempotentInventoryAction } from "@openbooks/engine/src/inventory/action-idempotency.ts";
import { postLandedCostVoucher } from "@openbooks/engine/src/inventory/landed-cost.ts";
import { reverseInventoryMovement } from "@openbooks/engine/src/inventory/reversal.ts";
import { transferInventory } from "@openbooks/engine/src/inventory/transfers.ts";
import { inventoryErrorStatus } from "@/lib/api/inventory-errors";
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { INVENTORY_ACTION_PERMISSIONS, type CataloguePermission } from '@openbooks/engine/src/organization/permissions.ts'
import { SubsidiaryError, defaultPostingSubsidiaryId, loadSubsidiaryContext } from '@openbooks/engine/src/organization/subsidiaries.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { notFound } from "@/lib/api/responses";

export const runtime = 'nodejs'

const inventoryActionBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('receive'), idempotencyKey: z.string().min(1), itemId: uuidId,
    stockLocationId: uuidId, subsidiaryId: uuidId.optional(), offsetAccountId: uuidId,
    lotId: nullableUuidId.optional(), serialId: nullableUuidId.optional(), date: isoDate().optional(),
    quantity: exactMoney(), unitCost: exactMoney(), memo: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('issue'), idempotencyKey: z.string().min(1), itemId: uuidId,
    stockLocationId: uuidId, subsidiaryId: uuidId.optional(), offsetAccountId: nullableUuidId.optional(),
    lotId: nullableUuidId.optional(), serialId: nullableUuidId.optional(), date: isoDate().optional(),
    quantity: exactMoney(), memo: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('adjust'), idempotencyKey: z.string().min(1), itemId: uuidId,
    stockLocationId: uuidId, subsidiaryId: uuidId.optional(), lotId: nullableUuidId.optional(),
    serialId: nullableUuidId.optional(), date: isoDate().optional(), quantity: exactMoney(),
    unitCost: exactMoney().optional(), memo: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('transfer'), idempotencyKey: z.string().min(1), itemId: uuidId,
    stockLocationId: uuidId, toStockLocationId: uuidId, subsidiaryId: uuidId.optional(),
    lotId: nullableUuidId.optional(), serialId: nullableUuidId.optional(), date: isoDate().optional(),
    quantity: exactMoney(), memo: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('build'), idempotencyKey: z.string().min(1), itemId: uuidId,
    stockLocationId: uuidId, subsidiaryId: uuidId.optional(), date: isoDate().optional(),
    quantity: exactMoney(), memo: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('landed'), idempotencyKey: z.string().min(1), itemId: uuidId,
    stockLocationId: uuidId, subsidiaryId: uuidId.optional(), offsetAccountId: uuidId,
    date: isoDate().optional(), quantity: exactMoney(), basis: z.enum(['value', 'quantity']).optional(),
    memo: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('reverse'), idempotencyKey: z.string().min(1), movementId: uuidId,
    date: isoDate(), memo: z.string().trim().min(5).max(500),
  }),
])

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
export const POST = defineRoute({
  authorize: async ({ request }) => {
    let action: string | undefined;
    try {
      const payload: unknown = await request.clone().json();
      if (typeof payload === "object" && payload !== null && "action" in payload && typeof payload.action === "string") {
        action = payload.action;
      }
    } catch {
      // Let the shared body parser return the malformed-body response after
      // authentication; an unknown discriminator cannot authorize a write.
    }
    const permission = action === undefined
      ? undefined
      : (INVENTORY_ACTION_PERMISSIONS as Record<string, CataloguePermission | undefined>)[action];
    let gate: Awaited<ReturnType<typeof guardPermission>>;
    if (permission) {
      gate = await guardPermission(permission);
    } else {
      let allowed: Awaited<ReturnType<typeof guardPermission>> | undefined;
      let refused: NextResponse | undefined;
      for (const candidate of Object.values(INVENTORY_ACTION_PERMISSIONS) as CataloguePermission[]) {
        const candidateGate = await guardPermission(candidate);
        if (!(candidateGate instanceof NextResponse)) {
          allowed = candidateGate;
          break;
        }
        refused = candidateGate;
      }
      gate = allowed ?? refused ?? NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (gate instanceof NextResponse) return gate;
    if (!(await isFeatureEnabled(gate.user.orgId, "inventory"))) {
      return NextResponse.json({ error: "feature disabled" }, { status: 404 });
    }
    return gate;
  },
  feature: { none: "The action-specific inventory authorization checks the inventory feature before dispatch." },
  body: inventoryActionBody,
  handler: async ({ body, authz: gate }) => {
  const user = gate.user

  if (body.action === 'reverse') {
    if (!body.movementId || !isUuid(body.movementId)) {
      return NextResponse.json({ error: 'movement required' }, { status: 422 })
    }
    if (!body.date) {
      return NextResponse.json({ error: 'reversal date required' }, { status: 422 })
    }
    if (typeof body.memo !== 'string' || body.memo.trim().length < 5 || body.memo.trim().length > 500) {
      return NextResponse.json({ error: 'reversal reason must be between 5 and 500 characters' }, { status: 422 })
    }
    // The movement's subsidiary and kind live on the row, not in the
    // request, so resolve them server-side and fence restricted callers
    // before any unwind.
    const source = await db.execute<{ subsidiary_id: string | null; kind: string | null }>(
      sql`select subsidiary_id, kind from inventory_movements where id = ${body.movementId} and org_id = ${user.orgId}`,
    )
    const movementSubsidiaryId = source.rows[0]?.subsidiary_id ?? null
    if (!source.rows[0] || (gate.allowedSubsidiaryIds && (!movementSubsidiaryId || !gate.allowedSubsidiaryIds.has(movementSubsidiaryId)))) {
      return notFound("record")
    }
    // Assembly operations reverse through their own controlled reversal
    // (consume legs, finished-good layer, and journal as one unit), never
    // the single-movement path — which refuses them. The dispatch stays
    // inside this items.reverse-gated, idempotency-wrapped branch, so a
    // build reversal carries the same authority and replay contract as
    // every other reversal.
    const isAssemblyLeg = source.rows[0]?.kind === 'assembly_build' || source.rows[0]?.kind === 'assembly_consume'
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
          execute: () => {
            const input = {
              movementId: body.movementId!,
              reversalDate: body.date!,
              reason: body.memo!,
            }
            return isAssemblyLeg
              ? reverseAssemblyBuild(user.orgId, user.id, input)
              : reverseInventoryMovement(user.orgId, user.id, input)
          },
        },
      )
      return NextResponse.json({ ok: true, replayed, ...res })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: inventoryErrorStatus(e) })
    }
  }
  if (!body.itemId || !isUuid(body.itemId)) return NextResponse.json({ error: 'item required' }, { status: 422 })
  if (!body.stockLocationId || !isUuid(body.stockLocationId)) {
    return NextResponse.json({ error: 'stock location required' }, { status: 422 })
  }
  const quantity = body.quantity
  if (quantity === undefined || toUnits(quantity) === 0n) {
    return NextResponse.json({ error: 'quantity required' }, { status: 422 })
  }
  const date = body.date ?? await businessToday(user.orgId)

  // An unscoped posting books to the hierarchy root through the shared
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

  try {
    if (body.action === 'receive') {
      const unitCost = body.unitCost
      if (unitCost === undefined) return NextResponse.json({ error: 'unit cost required' }, { status: 422 })
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
        lotId: body.lotId ?? undefined,
        serialId: body.serialId ?? undefined,
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
      const basis = body.basis ?? 'value'
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
        lotId: body.lotId ?? undefined,
        serialId: body.serialId ?? undefined,
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
        offsetAccountId: body.offsetAccountId ?? undefined,
        date,
        lotId: body.lotId ?? undefined,
        serialId: body.serialId ?? undefined,
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
      lotId: body.lotId ?? undefined,
      serialId: body.serialId ?? undefined,
      subsidiaryId,
      date,
      unitCost: body.unitCost,
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
    // failure (403) through the shared inventory mapping, mirroring the
    // subsidiary permission gate above.
    return apiErrorResponse(e, { safeStatus: inventoryErrorStatus(e) })
  }
  },
});
