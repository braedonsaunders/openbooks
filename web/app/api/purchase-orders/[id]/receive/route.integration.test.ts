import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __poReceiveAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "../../../../../lib/authz" &&
        context.parentURL?.includes("/api/purchase-orders/")) ||
      (specifier === "./authz" && context.parentURL?.endsWith("/lib/feature-gates.ts"))
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__poReceiveAudit.user,allowedSubsidiaryIds:null,permissions:['goods_receipts.create','items.post']}};export function can(){return true};export function guardSubsidiaryScope(){return null}",
          ),
      };
    }
    return next(specifier, context);
  },
});

const { GET, POST } = await import("./route.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const PAST_DATE = "2026-07-10";

async function seedApprovedPo(
  orgId: string,
  actorId: string,
  vendorId: string,
  subsidiaryId: string,
  documentDate: string,
  itemId: string,
  assetAccountId: string,
  stockLocationId: string,
  number: string,
  unit = "ea",
  cancelled = "0",
): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${orderId}, ${orgId}, 'purchase_order', ${number}, ${vendorId},
      ${subsidiaryId}, ${documentDate}, 'CAD', 'draft', '20', '0', '20',
      ${actorId}, ${actorId}
    )`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, quantity_cancelled, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (
      ${lineId}, ${orgId}, ${orderId}, 1, ${itemId}, ${assetAccountId}, 'Widget',
      '10', ${cancelled}, ${unit}, '2', '20', '0', '0', '0', ${stockLocationId}, '{}'::jsonb
    )`);
  // Approved lines are storage-immutable: issue the order only after its
  // lines exist.
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${orderId} and org_id = ${orgId}`);
  return { orderId, lineId };
}

async function seedTwoLinePo(
  orgId: string,
  actorId: string,
  vendorId: string,
  subsidiaryId: string,
  documentDate: string,
  itemId: string,
  assetAccountId: string,
  stockLocationId: string,
  number: string,
): Promise<{ orderId: string; lineIds: [string, string] }> {
  const orderId = randomUUID();
  const lineIds = [randomUUID(), randomUUID()] as [string, string];
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${orderId}, ${orgId}, 'purchase_order', ${number}, ${vendorId},
      ${subsidiaryId}, ${documentDate}, 'CAD', 'draft', '68', '0', '68',
      ${actorId}, ${actorId}
    )`);
  const specs = [
    { id: lineIds[0], n: 1, qty: "10", unit: "ea", price: "2", amount: "20" },
    { id: lineIds[1], n: 2, qty: "2", unit: "box", price: "24", amount: "48" },
  ];
  for (const s of specs) {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description,
         quantity, unit, unit_price, amount, tax_amount,
         quantity_fulfilled, quantity_billed, stock_location_id, custom)
      values (
        ${s.id}, ${orgId}, ${orderId}, ${s.n}, ${itemId}, ${assetAccountId}, 'Widget',
        ${s.qty}, ${s.unit}, ${s.price}, ${s.amount}, '0', '0', '0', ${stockLocationId}, '{}'::jsonb
      )`);
  }
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${orderId} and org_id = ${orgId}`);
  return { orderId, lineIds };
}

function postReceive(orderId: string, key: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  return POST(
    new Request(`http://openbooks.test/api/purchase-orders/${orderId}/receive`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: orderId }) } as never,
  ) as unknown as Promise<Response>;
}

function getReceive(orderId: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/purchase-orders/${orderId}/receive`), {
    params: Promise.resolve({ id: orderId }),
  } as never) as unknown as Promise<Response>;
}

async function receiptFacts(orgId: string, lineId: string) {
  return (
    await db.execute<{
      received: string;
      receipts: number;
      moved: string;
      receiptDate: string;
      postingDate: string;
    }>(
      sql`
      select (select quantity_fulfilled::text from document_lines where id = ${lineId}) as received,
             (select count(*)::int from documents where org_id = ${orgId} and kind = 'purchase_receipt') as receipts,
             (select coalesce(sum(quantity), 0)::text from inventory_movements
               where org_id = ${orgId} and status = 'posted') as moved,
             (select document_date::text from documents where org_id = ${orgId} and kind = 'purchase_receipt' limit 1) as "receiptDate",
             (select posting_date::text from journal_entries where org_id = ${orgId} limit 1) as "postingDate"
    `,
      "objects",
    )
  )[0]!;
}

test("receive prefill excludes cancelled purchase-order quantity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
    state.user = { orgId: org.orgId, id: actorId };
    const { orderId } = await seedApprovedPo(
      org.orgId,
      actorId,
      org.vendorId,
      org.subsidiaryId,
      org.date,
      org.items.fifo,
      org.accounts.invAsset,
      org.stockLocationId,
      "PO-RCV-CANCELLED",
      "ea",
      "6",
    );
    const response = await getReceive(orderId);
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as {
      lines: Array<{ remaining: string; maxReceivable: string }>;
    };
    assert.equal(body.lines.length, 1);
    assert.equal(toUnits(body.lines[0]!.remaining), toUnits("4"));
    assert.equal(toUnits(body.lines[0]!.maxReceivable), toUnits("4"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * The explicit receive endpoint posts a partial receipt dated in the past
 * (inside the open period) and replays a retried save instead of receiving
 * twice.
 */
test(
  "explicit receive posts a partial past-dated receipt exactly once",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
      state.user = { orgId: org.orgId, id: actorId };
      const { orderId, lineId } = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        org.date,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-RCV-1",
      );
      const key = randomUUID();
      const first = await postReceive(orderId, key, {
        receiptDate: PAST_DATE,
        lines: [{ sourceLineId: lineId, quantity: "4" }],
      });
      assert.equal(first.status, 200, await first.clone().text());
      const created = (await first.json()) as { kind: string; id: string; documentNumber: string };
      assert.equal(created.kind, "purchase_receipt");

      const facts = await receiptFacts(org.orgId, lineId);
      assert.equal(
        toUnits(facts.received),
        toUnits("4"),
        "only the entered quantity advances the order",
      );
      assert.equal(facts.receipts, 1);
      assert.equal(toUnits(facts.moved), toUnits("4"), "only the entered quantity moves stock");
      assert.equal(facts.receiptDate, PAST_DATE, "the receipt carries the entered past date");
      assert.equal(
        facts.postingDate,
        PAST_DATE,
        "the inventory journal posts on the entered past date",
      );

      const retry = await postReceive(orderId, key, {
        receiptDate: PAST_DATE,
        lines: [{ sourceLineId: lineId, quantity: "4" }],
      });
      assert.equal(retry.status, 200);
      assert.equal(((await retry.json()) as { replayed?: boolean }).replayed, true);
      const after = await receiptFacts(org.orgId, lineId);
      assert.equal(toUnits(after.received), toUnits("4"), "a retried save never double-receives");
      assert.equal(after.receipts, 1);
      assert.equal(toUnits(after.moved), toUnits("4"));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "explicit receive refuses without an idempotency key and over-receipt commits nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
      state.user = { orgId: org.orgId, id: actorId };
      const { orderId, lineId } = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        org.date,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-RCV-2",
      );
      const noKey = await postReceive(orderId, null, {
        receiptDate: org.date,
        lines: [{ sourceLineId: lineId, quantity: "1" }],
      });
      assert.equal(noKey.status, 400);

      const over = await postReceive(orderId, randomUUID(), {
        receiptDate: org.date,
        lines: [{ sourceLineId: lineId, quantity: "99" }],
      });
      assert.equal(over.status, 422);
      const facts = await receiptFacts(org.orgId, lineId);
      assert.equal(toUnits(facts.received), toUnits("0"), "a refused save advances nothing");
      assert.equal(facts.receipts, 0, "a refused save creates no receipt");
      assert.equal(toUnits(facts.moved), toUnits("0"), "a refused save moves no stock");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

/**
 * A two-line order can receive one line while the other waits at zero: the
 * zero line is left out (not received now), the entered line advances and
 * moves stock, and a later save receives the waiting line through its
 * explicit unit conversion (2 box at 12 per box moves 24 base units).
 */
test(
  "a two-line receipt skips a zero line and converts the later line",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
      state.user = { orgId: org.orgId, id: actorId };
      await db.execute(sql`
      update item_inventory_profiles set unit_conversions = '{"box": 12}'::jsonb
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);
      const { orderId, lineIds } = await seedTwoLinePo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        org.date,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-RCV-5",
      );
      const partial = await postReceive(orderId, randomUUID(), {
        receiptDate: org.date,
        lines: [
          { sourceLineId: lineIds[0], quantity: "3" },
          { sourceLineId: lineIds[1], quantity: "0" },
        ],
      });
      assert.equal(partial.status, 200, await partial.clone().text());
      const fulfilled = await db.execute<{ line: number; received: string }>(
        sql`
      select line_number as line, quantity_fulfilled::text as received from document_lines
       where id in (${lineIds[0]}, ${lineIds[1]}) order by line_number`,
        "objects",
      );
      assert.equal(toUnits(fulfilled[0]!.received), toUnits("3"), "the entered line advances");
      assert.equal(toUnits(fulfilled[1]!.received), toUnits("0"), "the zero line waits untouched");
      const moved = (
        await db.execute<{ moved: string }>(
          sql`
      select coalesce(sum(quantity), 0)::text as moved from inventory_movements
       where org_id = ${org.orgId} and status = 'posted'`,
          "objects",
        )
      )[0]!.moved;
      assert.equal(toUnits(moved), toUnits("3"), "only the entered line moves stock");

      const rest = await postReceive(orderId, randomUUID(), {
        receiptDate: org.date,
        lines: [{ sourceLineId: lineIds[1], quantity: "2" }],
      });
      assert.equal(rest.status, 200, await rest.clone().text());
      const after = (
        await db.execute<{ moved: string }>(
          sql`
      select coalesce(sum(quantity), 0)::text as moved from inventory_movements
       where org_id = ${org.orgId} and status = 'posted'`,
          "objects",
        )
      )[0]!.moved;
      assert.equal(toUnits(after), toUnits("27"), "the box line converts at 12 base units each");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

/**
 * Zero on every line refuses naming what to enter, and a malformed quantity
 * names the order line number — never a raw source id the operator cannot
 * resolve (and the sanitizer would redact to an ellipsis).
 */
test("all-zero and malformed receipts refuse with actionable messages", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
    state.user = { orgId: org.orgId, id: actorId };
    const { orderId, lineIds } = await seedTwoLinePo(
      org.orgId,
      actorId,
      org.vendorId,
      org.subsidiaryId,
      org.date,
      org.items.fifo,
      org.accounts.invAsset,
      org.stockLocationId,
      "PO-RCV-6",
    );
    const zeroes = await postReceive(orderId, randomUUID(), {
      receiptDate: org.date,
      lines: [
        { sourceLineId: lineIds[0], quantity: "0" },
        { sourceLineId: lineIds[1], quantity: "0.00" },
      ],
    });
    assert.equal(zeroes.status, 422);
    assert.match(
      String(((await zeroes.json()) as { error?: unknown }).error ?? ""),
      /at least one line/,
      "an all-zero receipt says what to enter",
    );

    const negative = await postReceive(orderId, randomUUID(), {
      receiptDate: org.date,
      lines: [{ sourceLineId: lineIds[0], quantity: "-1" }],
    });
    assert.equal(negative.status, 422);
    const message = String(((await negative.json()) as { error?: unknown }).error ?? "");
    assert.match(message, /line 1/, "the refusal names the order line number");
    assert.doesNotMatch(message, /[0-9a-f]{8}-[0-9a-f]{4}/, "never a raw internal id");

    const facts = await receiptFacts(org.orgId, lineIds[0]);
    assert.equal(toUnits(facts.received), toUnits("0"), "refused saves advance nothing");
    assert.equal(facts.receipts, 0, "refused saves create no receipt");
    assert.equal(toUnits(facts.moved), toUnits("0"), "refused saves move no stock");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * A line raised in an aliased unit ("Each" for the item's base "ea") posts
 * 1:1 with no conversion row; a genuinely unmapped unit ("crate") refuses
 * with its remedy and receives nothing.
 */
test(
  "unit aliases receive against the base unit; unknown units refuse with a message",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
      state.user = { orgId: org.orgId, id: actorId };
      const aliased = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        org.date,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-RCV-3",
        "Each",
      );
      const saved = await postReceive(aliased.orderId, randomUUID(), {
        receiptDate: org.date,
        lines: [{ sourceLineId: aliased.lineId, quantity: "10" }],
      });
      assert.equal(saved.status, 200, `an aliased unit saves, got: ${await saved.text()}`);
      const savedFacts = await receiptFacts(org.orgId, aliased.lineId);
      assert.equal(toUnits(savedFacts.received), toUnits("10"), "the alias receives in full");
      assert.equal(
        toUnits(savedFacts.moved),
        toUnits("10"),
        "the alias moves 1:1 against the base unit",
      );

      const { orderId: refusedId, lineId: refusedLine } = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        org.date,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-RCV-4",
        "crate",
      );
      const refused = await postReceive(refusedId, randomUUID(), {
        receiptDate: org.date,
        lines: [{ sourceLineId: refusedLine, quantity: "10" }],
      });
      assert.equal(refused.status, 422);
      const body = (await refused.json()) as {
        error?: unknown;
        code?: unknown;
        details?: { itemId?: unknown; itemName?: unknown; unit?: unknown; baseUnit?: unknown };
      };
      assert.match(
        String(body.error ?? ""),
        /no conversion to the item's base unit/,
        "the refusal renders its remedy instead of an empty answer",
      );
      // The drawer links the refusal to the item's costing section, so the
      // code and item identity ride the body — never message text alone.
      assert.equal(body.code, "ITEM_MISSING_UNIT_CONVERSION");
      assert.equal(body.details?.itemId, org.items.fifo);
      assert.equal(typeof body.details?.itemName, "string");
      assert.equal(body.details?.unit, "crate");
      const refusedFacts = await receiptFacts(org.orgId, refusedLine);
      assert.equal(toUnits(refusedFacts.received), toUnits("0"), "a refused save advances nothing");
      assert.equal(refusedFacts.receipts, 1, "only the aliased receipt exists");
      assert.equal(
        toUnits(refusedFacts.moved),
        toUnits("10"),
        "a refused save moves no further stock",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
