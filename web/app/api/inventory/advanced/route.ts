import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import {
  InventoryError,
  createTransferOrder,
  ensureLot,
  ensureSerial,
  postLandedCostVoucher,
  queryLotRecall,
  receiveTransferOrder,
  shipTransferOrder,
} from "@openbooks/engine/src/inventory.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const gate = await guardPermission("items.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "inventory"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const orgId = gate.user.orgId;
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "transfers";

  if (view === "recall") {
    const rows = await queryLotRecall(orgId, {
      lotNumber: url.searchParams.get("lotNumber") ?? undefined,
      lotId: url.searchParams.get("lotId") ?? undefined,
      itemId: url.searchParams.get("itemId") ?? undefined,
      expiresOnOrBefore: url.searchParams.get("expiresOnOrBefore") ?? undefined,
      includeExpiryOnly: url.searchParams.get("expiring") === "1",
    });
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
        left join inventory_movements im on im.lot_id = l.id and im.org_id = l.org_id
       where l.org_id = ${orgId}
       group by l.id, i.code, i.name
       order by l.lot_number
       limit 200
    `));
    return NextResponse.json({ lots: rows.rows });
  }

  if (view === "landed") {
    const rows = (await db.execute(sql`
      select id, document_number as "documentNumber", status, amount, basis, voucher_date as "voucherDate", memo
        from landed_cost_vouchers where org_id = ${orgId}
       order by voucher_date desc limit 50
    `));
    return NextResponse.json({ vouchers: rows.rows });
  }

  const transfers = (await db.execute(sql`
    select t.id, t.document_number as "documentNumber", t.status, t.ordered_on as "orderedOn",
           t.shipped_on as "shippedOn", t.received_on as "receivedOn", t.memo,
           sf.code as "fromCode", st.code as "toCode"
      from transfer_orders t
      left join stock_locations sf on sf.id = t.from_stock_location_id
      left join stock_locations st on st.id = t.to_stock_location_id
     where t.org_id = ${orgId}
     order by t.ordered_on desc, t.created_at desc
     limit 50
  `));
  return NextResponse.json({ transfers: transfers.rows });
}

export async function POST(req: Request) {
  const gate = await guardPermission("items.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "inventory"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const orgId = gate.user.orgId;
  const userId = gate.user.id;
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;

  try {
    switch (body.action) {
      case "createTransfer": {
        let subsidiaryId = body.subsidiaryId;
        if (!subsidiaryId || !isUuid(subsidiaryId)) {
          const r = (await db.execute<{ id: string }>(
            sql`select id from subsidiaries where org_id = ${orgId} order by created_at limit 1`,
          ));
          subsidiaryId = r.rows[0]?.id;
        }
        if (!subsidiaryId) return NextResponse.json({ error: "no subsidiary" }, { status: 422 });
        if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
          return NextResponse.json({ error: "subsidiary not permitted" }, { status: 403 });
        }
        const res = await createTransferOrder(orgId, userId, {
          fromStockLocationId: body.fromStockLocationId,
          toStockLocationId: body.toStockLocationId,
          subsidiaryId,
          orderedOn: body.orderedOn || (await businessToday(orgId)),
          inTransitAccountId: body.inTransitAccountId ?? null,
          memo: body.memo ?? null,
          lines: body.lines ?? [],
        });
        return NextResponse.json(res, { status: 201 });
      }
      case "shipTransfer": {
        const res = await shipTransferOrder(orgId, userId, body.id, body.date);
        return NextResponse.json(res);
      }
      case "receiveTransfer": {
        const res = await receiveTransferOrder(orgId, userId, body.id, body.date);
        return NextResponse.json(res);
      }
      case "postLandedVoucher": {
        let subsidiaryId = body.subsidiaryId;
        if (!subsidiaryId || !isUuid(subsidiaryId)) {
          const r = (await db.execute<{ id: string }>(
            sql`select id from subsidiaries where org_id = ${orgId} order by created_at limit 1`,
          ));
          subsidiaryId = r.rows[0]?.id;
        }
        if (!subsidiaryId) return NextResponse.json({ error: "no subsidiary" }, { status: 422 });
        if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(subsidiaryId)) {
          return NextResponse.json({ error: "subsidiary not permitted" }, { status: 403 });
        }
        const res = await postLandedCostVoucher(orgId, userId, {
          amount: String(body.amount),
          basis: body.basis ?? "value",
          freightAccountId: body.freightAccountId,
          subsidiaryId,
          voucherDate: body.voucherDate || (await businessToday(orgId)),
          sourceDocumentLineId: body.sourceDocumentLineId ?? null,
          memo: body.memo ?? null,
          targets: body.targets ?? [],
        });
        return NextResponse.json(res, { status: 201 });
      }
      case "ensureLot": {
        const id = await ensureLot(orgId, body.itemId, body.lotNumber, body.expiresOn ?? null, userId);
        return NextResponse.json({ id });
      }
      case "ensureSerial": {
        const id = await ensureSerial(orgId, body.itemId, body.serialNumber, body.stockLocationId ?? null, userId);
        return NextResponse.json({ id });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    const status = e instanceof InventoryError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
