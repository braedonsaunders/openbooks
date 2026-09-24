import { exactMoney, isoDate, nullableUuidId, parseJsonBody, uuidId } from "@/lib/api/json";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { InventoryOwnershipError } from "@openbooks/engine/src/inventory/contracts.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { inventoryErrorStatus } from "@/lib/api/inventory-errors";
import { createTransferOrder, receiveTransferOrder, shipTransferOrder } from "@openbooks/engine/src/inventory/transfer-orders.ts";
import { ensureLot, ensureSerial, queryLotRecall } from "@openbooks/engine/src/inventory/tracking.ts";
import { executeIdempotentInventoryAction } from "@openbooks/engine/src/inventory/action-idempotency.ts";
import { postLandedCostVoucher, reverseLandedCostVoucher } from "@openbooks/engine/src/inventory/landed-cost.ts";
import { SubsidiaryError, defaultPostingSubsidiaryId, loadSubsidiaryContext } from "@openbooks/engine/src/organization/subsidiaries.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import {
  INVENTORY_ADVANCED_ACTION_PERMISSIONS,
  type CataloguePermission,
} from "@openbooks/engine/src/organization/permissions.ts";

export const runtime = "nodejs";

const advancedInventoryBody = z.looseObject({
  action: z.string().optional(),
  idempotencyKey: z.string().optional(),
  id: uuidId.optional(),
  itemId: uuidId.optional(),
  subsidiaryId: uuidId.optional(),
  fromStockLocationId: uuidId.optional(),
  toStockLocationId: uuidId.optional(),
  stockLocationId: nullableUuidId.optional(),
  inTransitAccountId: nullableUuidId.optional(),
  transitStockLocationId: nullableUuidId.optional(),
  freightAccountId: uuidId.optional(),
  sourceDocumentLineId: nullableUuidId.optional(),
  orderedOn: isoDate().optional(),
  voucherDate: isoDate().optional(),
  date: isoDate().optional(),
  expiresOn: isoDate().nullable().optional(),
  amount: exactMoney().optional(),
  basis: z.enum(["value", "quantity", "weight", "manual"]).optional(),
  memo: z.string().nullable().optional(),
  lotNumber: z.string().optional(),
  serialNumber: z.string().optional(),
  lines: z.array(z.looseObject({ itemId: uuidId, quantity: exactMoney(), lotId: nullableUuidId.optional(), serialId: nullableUuidId.optional() })).optional(),
  targets: z.array(z.looseObject({ itemId: uuidId, stockLocationId: uuidId, manualAmount: exactMoney().nullable().optional() })).optional(),
});

export async function GET(req: Request) {
  const gate = await guardPermission("items.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "inventory"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const orgId = gate.user.orgId;
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "transfers";
  // `null` means org-wide visibility. A non-null empty set means the caller
  // has no subsidiary grants and must see no rows or aggregate metadata.
  const allowedSubsidiaryIds = gate.allowedSubsidiaryIds
    ? [...gate.allowedSubsidiaryIds]
    : null;
  const scopeFor = (column: ReturnType<typeof sql>) =>
    allowedSubsidiaryIds === null
      ? sql``
      : allowedSubsidiaryIds.length === 0
        ? sql`and false`
        : sql`and ${column} in (${sql.join(
            allowedSubsidiaryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;

  if (view === "recall") {
    // Recall filters are cast to uuid/date inside the engine query; validate
    // them here so a malformed filter is a request failure, not a server one.
    const lotId = url.searchParams.get("lotId") ?? undefined;
    const itemId = url.searchParams.get("itemId") ?? undefined;
    const expiresOnOrBefore = url.searchParams.get("expiresOnOrBefore") ?? undefined;
    if (lotId !== undefined && !isUuid(lotId)) {
      return NextResponse.json({ error: "lotId must be a valid id" }, { status: 422 });
    }
    if (itemId !== undefined && !isUuid(itemId)) {
      return NextResponse.json({ error: "itemId must be a valid id" }, { status: 422 });
    }
    if (expiresOnOrBefore !== undefined && !isoDate().safeParse(expiresOnOrBefore).success) {
      return NextResponse.json({ error: "expiresOnOrBefore must be YYYY-MM-DD" }, { status: 422 });
    }
    const recallFilter = {
      lotNumber: url.searchParams.get("lotNumber") ?? undefined,
      lotId,
      itemId,
      expiresOnOrBefore,
      includeExpiryOnly: url.searchParams.get("expiring") === "1",
      subsidiaryIds: allowedSubsidiaryIds,
    } as Parameters<typeof queryLotRecall>[1];
    const rows = await queryLotRecall(orgId, recallFilter);
    return NextResponse.json({ rows });
  }

  if (view === "lots") {
    const rows = (await db.execute(sql`
      select l.id, l.lot_number as "lotNumber", l.expires_on as "expiresOn", l.item_id as "itemId",
             i.code as "itemCode", i.name as "itemName",
             coalesce(sum(case when im.kind in ('receipt','transfer_in','return','adjustment') and im.quantity > 0 then im.quantity else 0 end), 0)
               - coalesce(sum(case when im.quantity < 0 then -im.quantity else 0 end), 0) as "approxQty"
        from lots l
        left join items i on i.id = l.item_id and i.org_id = l.org_id
        left join inventory_movements im on im.lot_id = l.id and im.org_id = l.org_id ${scopeFor(sql`im.subsidiary_id`)}
       where l.org_id = ${orgId}
         ${allowedSubsidiaryIds === null || allowedSubsidiaryIds.length > 0 ? sql`` : sql`and false`}
         ${allowedSubsidiaryIds && allowedSubsidiaryIds.length > 0 ? sql`and im.id is not null` : sql``}
       group by l.id, i.code, i.name
       order by l.lot_number
       limit 200
    `));
    return NextResponse.json({ lots: rows.rows });
  }

  if (view === "landed") {
    // The reversal picker pages this list. A newest-50-only slice strands an
    // older still-posted voucher behind newer reversed ones, so the list is
    // server-filtered by status, server-searched by number/memo, and
    // cursor-paged with a total — every posted voucher stays reachable.
    const statusParam = url.searchParams.get("status");
    const status = statusParam === null || statusParam === "" ? null : statusParam;
    if (status !== null && status !== "posted" && status !== "void") {
      return NextResponse.json({ error: "status must be posted or void" }, { status: 422 });
    }
    const limitParam = url.searchParams.get("limit");
    let limit = 50;
    if (limitParam !== null) {
      limit = Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return NextResponse.json({ error: "limit must be an integer between 1 and 100" }, { status: 422 });
      }
    }
    const q = (url.searchParams.get("q") ?? "").trim();
    const cursorParam = url.searchParams.get("cursor");
    let cursor: { voucherDate: string; id: string } | null = null;
    if (cursorParam !== null && cursorParam !== "") {
      try {
        const parsed = JSON.parse(Buffer.from(cursorParam, "base64url").toString("utf8")) as Partial<{
          voucherDate: unknown;
          id: unknown;
        }>;
        if (typeof parsed?.voucherDate !== "string" || typeof parsed?.id !== "string" || !isUuid(parsed.id)) {
          throw new Error("bad cursor");
        }
        cursor = { voucherDate: parsed.voucherDate, id: parsed.id };
      } catch {
        return NextResponse.json({ error: "page cursor is invalid — reload the list from the first page" }, { status: 422 });
      }
    }
    const statusScope = status === null ? sql`` : sql`and status = ${status}`;
    const searchScope = q === "" ? sql`` : sql`and (document_number ilike ${`%${q}%`} or coalesce(memo, '') ilike ${`%${q}%`})`;
    const cursorScope =
      cursor === null
        ? sql``
        : sql`and (voucher_date < ${cursor.voucherDate}::date
            or (voucher_date = ${cursor.voucherDate}::date and id > ${cursor.id}))`;
    const total = Number(
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from landed_cost_vouchers
         where org_id = ${orgId} ${scopeFor(sql`subsidiary_id`)} ${statusScope} ${searchScope}`)).rows[0]?.n ?? 0,
    );
    const rows = (await db.execute(sql`
      select id, document_number as "documentNumber", status, amount, basis, voucher_date as "voucherDate", memo
        from landed_cost_vouchers where org_id = ${orgId}
       ${scopeFor(sql`subsidiary_id`)} ${statusScope} ${searchScope} ${cursorScope}
       order by voucher_date desc, id limit ${limit + 1}
    `));
    const page = rows.rows as Array<{ voucherDate: string; id: string } & Record<string, unknown>>;
    const hasMore = page.length > limit;
    const visible = hasMore ? page.slice(0, limit) : page;
    const last = visible[visible.length - 1];
    return NextResponse.json({
      vouchers: visible,
      totalCount: total,
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ voucherDate: last.voucherDate, id: last.id }), "utf8").toString("base64url")
          : null,
    });
  }

  const transfers = (await db.execute(sql`
    select t.id, t.document_number as "documentNumber", t.status, t.ordered_on as "orderedOn",
           t.shipped_on as "shippedOn", t.received_on as "receivedOn", t.memo,
           sf.code as "fromCode", st.code as "toCode"
      from transfer_orders t
     left join stock_locations sf on sf.id = t.from_stock_location_id and sf.org_id = t.org_id
     left join stock_locations st on st.id = t.to_stock_location_id and st.org_id = t.org_id
     where t.org_id = ${orgId}
       ${scopeFor(sql`t.subsidiary_id`)}
     order by t.ordered_on desc, t.created_at desc
     limit 50
  `));
  return NextResponse.json({ transfers: transfers.rows });
}

export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, advancedInventoryBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data));
  const action = typeof body?.action === "string" ? body.action : undefined;
  // ensureLot/ensureSerial only mint catalog identifiers (idempotent by
  // construction), so they keep the catalog-maintenance grant and stay outside
  // the replay boundary; every stock-moving verb demands the monetary
  // authority mapped in INVENTORY_ADVANCED_ACTION_PERMISSIONS AND executes
  // through the engine's canonical idempotency boundary, which fails closed
  // on a missing or malformed idempotencyKey.
  const permission: CataloguePermission | undefined =
    action === "ensureLot" || action === "ensureSerial"
      ? "items.manage"
      : (INVENTORY_ADVANCED_ACTION_PERMISSIONS as Record<string, CataloguePermission | undefined>)[
          action as string
        ];
  if (!permission) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  const gate = await guardPermission(permission);
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "inventory"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const orgId = gate.user.orgId;
  const userId = gate.user.id;

  /** Refuse restricted callers any order whose subsidiary they cannot see. */
  const orderSubsidiaryInScope = async (orderId: unknown): Promise<boolean> => {
    if (!gate.allowedSubsidiaryIds) return true;
    if (typeof orderId !== "string" || !isUuid(orderId)) return false;
    const r = await db.execute<{ subsidiary_id: string | null }>(
      sql`select subsidiary_id from transfer_orders where id = ${orderId} and org_id = ${orgId}`,
    );
    const subsidiaryId = r.rows[0]?.subsidiary_id ?? null;
    return subsidiaryId !== null && gate.allowedSubsidiaryIds.has(subsidiaryId);
  };

  /** Refuse restricted callers any landed-cost voucher whose subsidiary they cannot see. */
  const voucherSubsidiaryInScope = async (voucherId: unknown): Promise<boolean> => {
    if (!gate.allowedSubsidiaryIds) return true;
    if (typeof voucherId !== "string" || !isUuid(voucherId)) return false;
    const r = await db.execute<{ subsidiary_id: string | null }>(
      sql`select subsidiary_id from landed_cost_vouchers where id = ${voucherId} and org_id = ${orgId}`,
    );
    const subsidiaryId = r.rows[0]?.subsidiary_id ?? null;
    return subsidiaryId !== null && gate.allowedSubsidiaryIds.has(subsidiaryId);
  };

  /** Run one monetary action through the engine's canonical replay boundary. */
  const idempotent = <T>(operation: string, request: unknown, execute: () => Promise<T>) =>
    executeIdempotentInventoryAction(orgId, userId, {
      operation,
      idempotencyKey: body?.idempotencyKey,
      request,
      execute,
    });

  /**
   * Locked rechecks inside the write transaction: the orderSubsidiaryInScope
   * / voucherSubsidiaryInScope probes above can authorize an A record while
   * a concurrent A→B reassignment lands before the service commits (the
   * service joins this transaction, so the lock covers its whole unit —
   * including retries). Throw the inventory-domain 403 the probes answer
   * with; the outer catch maps it.
   */
  // A row deleted between the probe and this lock is the service's own
  // not-found to name — only a present-but-out-of-scope row refuses here.
  const lockedOrderFence = async (orderId: string): Promise<void> => {
    const r = await db.execute<{ subsidiary_id: string | null }>(
      sql`select subsidiary_id from transfer_orders where id = ${orderId} and org_id = ${orgId} for update`,
    );
    const subsidiaryId = r.rows[0]?.subsidiary_id ?? null;
    if (subsidiaryId !== null && gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
      throw new InventoryOwnershipError("subsidiary not permitted");
    }
  };

  const lockedVoucherFence = async (voucherId: string): Promise<void> => {
    const r = await db.execute<{ subsidiary_id: string | null }>(
      sql`select subsidiary_id from landed_cost_vouchers where id = ${voucherId} and org_id = ${orgId} for update`,
    );
    const subsidiaryId = r.rows[0]?.subsidiary_id ?? null;
    if (subsidiaryId !== null && gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
      throw new InventoryOwnershipError("subsidiary not permitted");
    }
  };

  try {
    switch (body.action) {
      case "createTransfer": {
        if (!body.fromStockLocationId || !body.toStockLocationId || !body.lines?.length) {
          return NextResponse.json({ error: "source, destination and transfer lines required" }, { status: 422 });
        }
        let subsidiaryId = body.subsidiaryId;
        if (subsidiaryId === undefined) {
          try {
            subsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
          } catch (e) {
            if (!(e instanceof SubsidiaryError)) throw e;
            return NextResponse.json({ error: "no subsidiary" }, { status: 422 });
          }
        }
        if (!subsidiaryId) return NextResponse.json({ error: "no subsidiary" }, { status: 422 });
        if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
          return NextResponse.json({ error: "subsidiary not permitted" }, { status: 403 });
        }
        const lines = body.lines.map((line) => ({
          itemId: line.itemId,
          quantity: line.quantity,
          lotId: line.lotId ?? null,
          serialId: line.serialId ?? null,
        }));
        const input = {
          fromStockLocationId: body.fromStockLocationId,
          toStockLocationId: body.toStockLocationId,
          subsidiaryId,
          orderedOn: body.orderedOn ?? (await businessToday(orgId)),
          inTransitAccountId: body.inTransitAccountId ?? null,
          transitStockLocationId: body.transitStockLocationId ?? null,
          memo: body.memo ?? null,
          lines,
        };
        const { value: res, replayed } = await idempotent(
          "inventory.transfer-order.create",
          input,
          () => createTransferOrder(orgId, userId, input),
        );
        return NextResponse.json({ replayed, ...res }, { status: 201 });
      }
      case "shipTransfer": {
        if (!body.id) return NextResponse.json({ error: "transfer order required" }, { status: 422 });
        if (!(await orderSubsidiaryInScope(body.id))) {
          return NextResponse.json({ error: "subsidiary not permitted" }, { status: 403 });
        }
        const { value: res, replayed } = await withOrgTransaction(orgId, async () => {
          await lockedOrderFence(body.id!);
          return idempotent(
            "inventory.transfer-order.ship",
            { id: body.id, date: body.date },
            () => shipTransferOrder(orgId, userId, body.id!, body.date),
          );
        });
        return NextResponse.json({ replayed, ...res });
      }
      case "receiveTransfer": {
        if (!body.id) return NextResponse.json({ error: "transfer order required" }, { status: 422 });
        if (!(await orderSubsidiaryInScope(body.id))) {
          return NextResponse.json({ error: "subsidiary not permitted" }, { status: 403 });
        }
        const { value: res, replayed } = await withOrgTransaction(orgId, async () => {
          await lockedOrderFence(body.id!);
          return idempotent(
            "inventory.transfer-order.receive",
            { id: body.id, date: body.date },
            () => receiveTransferOrder(orgId, userId, body.id!, body.date),
          );
        });
        return NextResponse.json({ replayed, ...res });
      }
      case "postLandedVoucher": {
        if (!body.freightAccountId) return NextResponse.json({ error: "freight account required" }, { status: 422 });
        if (body.amount === undefined || !body.targets?.length) {
          return NextResponse.json({ error: "amount and landed-cost targets required" }, { status: 422 });
        }
        let subsidiaryId = body.subsidiaryId;
        if (subsidiaryId === undefined) {
          try {
            subsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
          } catch (e) {
            if (!(e instanceof SubsidiaryError)) throw e;
            return NextResponse.json({ error: "no subsidiary" }, { status: 422 });
          }
        }
        if (!subsidiaryId) return NextResponse.json({ error: "no subsidiary" }, { status: 422 });
        if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
          return NextResponse.json({ error: "subsidiary not permitted" }, { status: 403 });
        }
        const targets = body.targets.map((target) => ({
          itemId: target.itemId,
          stockLocationId: target.stockLocationId,
          manualAmount: target.manualAmount ?? null,
        }));
        const input = {
          amount: body.amount,
          basis: body.basis ?? "value",
          freightAccountId: body.freightAccountId,
          subsidiaryId,
          voucherDate: body.voucherDate ?? (await businessToday(orgId)),
          sourceDocumentLineId: body.sourceDocumentLineId ?? null,
          memo: body.memo ?? null,
          targets,
        };
        const { value: res, replayed } = await idempotent(
          "inventory.landed-voucher.post",
          input,
          () => postLandedCostVoucher(orgId, userId, input),
        );
        return NextResponse.json({ replayed, ...res }, { status: 201 });
      }
      case "reverseLandedVoucher": {
        if (!body.id) return NextResponse.json({ error: "landed-cost voucher required" }, { status: 422 });
        if (!body.date) {
          return NextResponse.json({ error: "reversal date required" }, { status: 422 });
        }
        if (typeof body.memo !== "string" || body.memo.trim().length < 5 || body.memo.trim().length > 500) {
          return NextResponse.json({ error: "reversal reason must be between 5 and 500 characters" }, { status: 422 });
        }
        if (!(await voucherSubsidiaryInScope(body.id))) {
          return NextResponse.json({ error: "subsidiary not permitted" }, { status: 403 });
        }
        const { value: res, replayed } = await withOrgTransaction(orgId, async () => {
          await lockedVoucherFence(body.id!);
          return idempotent(
            "inventory.landed-voucher.reverse",
            { id: body.id, date: body.date, reason: body.memo },
            () =>
              reverseLandedCostVoucher(orgId, userId, {
                voucherId: body.id!,
                reversalDate: body.date!,
                reason: body.memo!,
              }),
          );
        });
        return NextResponse.json({ replayed, ...res });
      }
      case "ensureLot": {
        if (!body.itemId || !body.lotNumber) return NextResponse.json({ error: "item and lot number required" }, { status: 422 });
        const id = await ensureLot(orgId, body.itemId, body.lotNumber, body.expiresOn ?? null, userId);
        return NextResponse.json({ id });
      }
      case "ensureSerial": {
        if (!body.itemId || !body.serialNumber) return NextResponse.json({ error: "item and serial number required" }, { status: 422 });
        const id = await ensureSerial(orgId, body.itemId, body.serialNumber, body.stockLocationId ?? null, userId);
        return NextResponse.json({ id });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    // One shared mapping: an engine ownership refusal is a 403, key reuse
    // with different input is a 409, any other InventoryError is a 422.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: inventoryErrorStatus(e) },
    );
  }
}
