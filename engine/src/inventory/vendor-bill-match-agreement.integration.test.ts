import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import {
  billMatchCandidates,
  matchVendorBillLines,
} from "@openbooks/engine/payables/vendor-bill-matching";
import { BILL_LINES_UNMATCHED } from "@openbooks/engine/inventory/contracts/module";
import { receivePurchaseOrder } from "../../../web/lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface OrgSeed {
  orgId: string;
  actorId: string;
  vendorId: string;
  subsidiaryId: string;
  date: string;
  fifo: string;
  avg: string;
  asset: string;
  clearing: string;
  ap: string;
  ar: string;
  bank: string;
  location: string;
}

async function seedOrg(): Promise<OrgSeed> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "AP Clerk", "admin");
  await db.execute(sql`
    update item_inventory_profiles set unit_conversions = '{"lb": 1}'::jsonb
     where org_id = ${org.orgId} and item_id in (${org.items.fifo}, ${org.items.movingAvg})
  `);
  return {
    orgId: org.orgId,
    actorId,
    vendorId: org.vendorId,
    subsidiaryId: org.subsidiaryId,
    date: org.date,
    fifo: org.items.fifo,
    avg: org.items.movingAvg,
    asset: org.accounts.invAsset,
    clearing: org.accounts.clearing,
    ap: org.accounts.ap,
    ar: org.accounts.ar,
    bank: org.accounts.bank,
    location: org.stockLocationId,
  };
}

async function seedApprovedPo(
  seed: OrgSeed,
  number: string,
  vendorId: string,
): Promise<{ orderId: string; lineA: string; lineB: string }> {
  const orderId = randomUUID();
  const lineA = randomUUID();
  const lineB = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${orderId}, ${seed.orgId}, 'purchase_order', ${number}, ${vendorId},
      ${seed.subsidiaryId}, ${seed.date}, 'CAD', 'draft', '19828', '0', '19828',
      ${seed.actorId}, ${seed.actorId}
    )`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values
      (${lineA}, ${seed.orgId}, ${orderId}, 1, ${seed.fifo}, ${seed.asset},
       'Grain A', '2888', 'LB', '6', '17328', '0', '0', '0', ${seed.location}, '{}'::jsonb),
      (${lineB}, ${seed.orgId}, ${orderId}, 2, ${seed.avg}, ${seed.asset},
       'Grain B', '500', 'ea', '5', '2500', '0', '0', '0', ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${seed.actorId}
     where id = ${orderId} and org_id = ${seed.orgId}`);
  return { orderId, lineA, lineB };
}

async function seedHandBill(seed: OrgSeed, number: string, vendorId: string): Promise<string> {
  const billId = randomUUID();
  const currency = (
    await db.execute<{ c: string }>(
      sql`select base_currency as c from orgs where id = ${seed.orgId}`,
      "objects",
    )
  )[0]!.c;
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                           status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
    values (${billId}, ${seed.orgId}, 'vendor_bill', ${number}, ${vendorId}, ${seed.date}, ${seed.date},
            ${currency}, 'draft', ${seed.subsidiaryId}, '16383.60', '0', '16383.60', '{}'::jsonb, ${seed.actorId})
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
       unit_price, amount, tax_amount, stock_location_id, custom)
    values
      (${randomUUID()}, ${seed.orgId}, ${billId}, 1, ${seed.fifo}, ${seed.clearing},
       'Grain A', '2128', 'lb', '6.20', '13193.60', '0', ${seed.location}, '{}'::jsonb),
      (${randomUUID()}, ${seed.orgId}, ${billId}, 2, ${seed.avg}, ${seed.clearing},
       'Grain B', '500', 'ea', '5.10', '2550.00', '0', ${seed.location}, '{}'::jsonb),
      (${randomUUID()}, ${seed.orgId}, ${billId}, 3, null, ${seed.asset},
       'Freight', '1', 'lot', '640', '640', '0', ${seed.location}, '{}'::jsonb)
  `);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
  );
  return billId;
}

async function postBill(seed: OrgSeed, billId: string): Promise<void> {
  await withOrg(seed.orgId, () =>
    postDocument(billId, { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } }),
  );
}

/** The posting guard's refusal, with its machine-readable evidence. */
async function guardRefusal(
  seed: OrgSeed,
  billId: string,
): Promise<{ code: string; numbers: string[]; lineNumber: number }> {
  const failure = await postBill(seed, billId).then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(failure instanceof Error, "posting must refuse while a matchable line stays unlinked");
  const code = (failure as { code?: unknown }).code;
  assert.equal(code, BILL_LINES_UNMATCHED);
  const details = (
    failure as { details?: { lineNumber?: unknown; purchaseOrderNumbers?: unknown } }
  ).details;
  assert.ok(Array.isArray(details?.purchaseOrderNumbers), "the refusal names its purchase orders");
  return {
    code: String(code),
    numbers: [...(details?.purchaseOrderNumbers as string[])].sort(),
    lineNumber: Number(details?.lineNumber),
  };
}

function candidateNumbers(
  lines: { lineNumber: number; candidates: { purchaseOrderNumber: string }[] }[],
  lineNumber: number,
): string[] {
  const line = lines.find((entry) => entry.lineNumber === lineNumber);
  assert.ok(line, `the dialog lists bill line ${lineNumber}`);
  return [...new Set(line.candidates.map((candidate) => candidate.purchaseOrderNumber))].sort();
}

/**
 * Partial and full receipts agree: posting matches a line automatically
 * exactly when the Match dialog offers it one covering order line, and
 * the guard refuses naming exactly what the dialog offers when a line is
 * ambiguous. The automatic match and the refusal share the posting
 * transaction: a refused post stamps nothing and advances nothing. An
 * explicit match of the ambiguous line then lets the same bill post
 * clearing received-not-billed.
 */
test(
  "guard and match dialog agree across partial and full receipts, then the bill clears GRNB",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const po = await seedApprovedPo(seed, "PO-M38-01", seed.vendorId);
      await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [
          { sourceLineId: po.lineA, quantity: "2128" },
          { sourceLineId: po.lineB, quantity: "500" },
        ],
      });
      // A second order covers the same second item, so the bill's second
      // line is ambiguous while its first line has exactly one cover.
      const po2 = await seedApprovedPo(seed, "PO-M38-02", seed.vendorId);
      await receivePurchaseOrder(seed.orgId, seed.actorId, po2.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po2.lineB, quantity: "500" }],
      });
      const billId = await seedHandBill(seed, "BILL-M38-1", seed.vendorId);

      const dialog = await withOrg(seed.orgId, () => billMatchCandidates(seed.orgId, billId));
      assert.deepEqual(dialog.lines.length, 3);
      const line1 = dialog.lines.find((entry) => entry.lineNumber === 1)!;
      assert.equal(line1.candidates.length, 1, "the partly received line offers its order line");
      assert.equal(line1.candidates[0]!.purchaseOrderLineNumber, 1);
      assert.equal(
        toUnits(line1.candidates[0]!.billableQuantity),
        toUnits("2128"),
        "only received-and-unbilled cover is billable",
      );
      assert.equal(
        line1.candidates[0]!.receipts.length,
        1,
        "the candidate names its goods receipt",
      );
      const line2 = dialog.lines.find((entry) => entry.lineNumber === 2)!;
      assert.equal(line2.candidates.length, 2, "the twice-covered line offers both order lines");
      assert.deepEqual(
        candidateNumbers(dialog.lines, 3),
        [],
        "the freight line has nothing to match",
      );

      // The ambiguous line refuses with exactly what the dialog offers —
      // and the automatic match of the first line rolls back with it.
      const refused = await guardRefusal(seed, billId);
      assert.equal(refused.lineNumber, 2);
      assert.deepEqual(
        refused.numbers,
        candidateNumbers(dialog.lines, 2),
        "the guard lists exactly what the dialog offers",
      );
      const leaked = (
        await db.execute<{ stamps: number; billed: string }>(
          sql`
      select (select count(*)::int from document_lines
               where org_id = ${seed.orgId} and document_id = ${billId}
                 and custom ? 'purchaseOrderLineId') as stamps,
             (select coalesce(sum(quantity_billed), 0)::text from document_lines
               where org_id = ${seed.orgId} and id in (${po.lineA}, ${po.lineB}, ${po2.lineA}, ${po2.lineB})) as billed
    `,
          "objects",
        )
      )[0]!;
      assert.equal(leaked.stamps, 0, "a refused post stamps no match");
      assert.equal(toUnits(leaked.billed), toUnits("0"), "a refused post advances no billed cover");

      // Matching the ambiguous line explicitly lets the same bill post.
      const billLineIds = await db.execute<{ id: string }>(
        sql`
      select id from document_lines
       where org_id = ${seed.orgId} and document_id = ${billId} and line_number in (1, 2) order by line_number
    `,
        "objects",
      );
      await withOrg(seed.orgId, () =>
        matchVendorBillLines({
          orgId: seed.orgId,
          billId,
          actorId: seed.actorId,
          matches: [{ billLineId: billLineIds[1]!.id, purchaseOrderLineId: po.lineB }],
        }),
      );

      await postBill(seed, billId);
      const facts = (
        await db.execute<{
          status: string;
          clearing: string;
          onHand: string;
          billReceipts: number;
          billedA: string;
          billedB: string;
          billedC: string;
        }>(
          sql`
      select (select status from documents where id = ${billId}) as status,
             (select coalesce(sum(l.amount), 0)::text from journal_lines l
               join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
              where l.org_id = ${seed.orgId} and l.account_id = ${seed.clearing} and e.status = 'posted') as clearing,
             (select coalesce(sum(quantity), 0)::text from inventory_movements
               where org_id = ${seed.orgId} and status = 'posted'
                 and item_id in (${seed.fifo}, ${seed.avg})) as "onHand",
             (select count(*)::int from inventory_movements m
               join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
              where m.org_id = ${seed.orgId} and l.document_id = ${billId} and m.kind = 'receipt') as "billReceipts",
             (select quantity_billed::text from document_lines where id = ${po.lineA}) as "billedA",
             (select quantity_billed::text from document_lines where id = ${po.lineB}) as "billedB",
             (select quantity_billed::text from document_lines where id = ${po2.lineB}) as "billedC"
    `,
          "objects",
        )
      )[0]!;
      assert.equal(facts.status, "posted");
      assert.equal(
        toUnits(facts.clearing),
        toUnits("-2500"),
        "only the unmatched second receipt's cover stands",
      );
      assert.equal(
        toUnits(facts.onHand),
        toUnits("3128"),
        "the matched bill receives nothing again",
      );
      assert.equal(facts.billReceipts, 0);
      assert.equal(
        toUnits(facts.billedA),
        toUnits("2128"),
        "the first line matched automatically on post",
      );
      assert.equal(toUnits(facts.billedB), toUnits("500"), "the second line matched explicitly");
      assert.equal(toUnits(facts.billedC), toUnits("0"), "the unchosen cover is untouched");
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * Ordered-but-unreceived quantity is not matchable: with no receipt behind
 * the order line the dialog offers nothing; posting refuses until receipt.
 */
test(
  "ordered-but-unreceived order lines offer no match and block unmatched stock posting",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      await seedApprovedPo(seed, "PO-M38-02", seed.vendorId);
      const billId = randomUUID();
      const currency = (
        await db.execute<{ c: string }>(
          sql`select base_currency as c from orgs where id = ${seed.orgId}`,
          "objects",
        )
      )[0]!.c;
      await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                             status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
      values (${billId}, ${seed.orgId}, 'vendor_bill', 'BILL-M38-2', ${seed.vendorId}, ${seed.date}, ${seed.date},
              ${currency}, 'draft', ${seed.subsidiaryId}, '510', '0', '510', '{}'::jsonb, ${seed.actorId})
    `);
      await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
         unit_price, amount, tax_amount, stock_location_id, custom)
      values (${randomUUID()}, ${seed.orgId}, ${billId}, 1, ${seed.avg}, ${seed.clearing},
              'Grain B', '100', 'ea', '5.10', '510', '0', ${seed.location}, '{}'::jsonb)
    `);
      await db.execute(
        sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
      );
      const dialog = await withOrg(seed.orgId, () => billMatchCandidates(seed.orgId, billId));
      assert.deepEqual(
        candidateNumbers(dialog.lines, 1),
        [],
        "nothing received means nothing to match",
      );
      await assert.rejects(postBill(seed, billId), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code: string }).code, "BILL_LINES_UNMATCHED");
        return true;
      });
      const status = (
        await db.execute<{ status: string }>(
          sql`select status from documents where id = ${billId}`,
          "objects",
        )
      )[0]!.status;
      assert.equal(status, "approved", "the refused posting preserves the approved bill");
      const movements = await db.execute(
        sql`select id from inventory_movements where org_id=${seed.orgId}`,
        "objects",
      );
      assert.equal(
        movements.length,
        0,
        "unreceived stock is not received through an unmatched bill",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * Another vendor's received cover is not matchable: the guard stays silent
 * and the dialog offers nothing, instead of pointing at an order the match
 * would refuse as a different vendor.
 */
test(
  "another vendor's received cover is invisible to the guard and the dialog",
  { skip: !DB },
  async () => {
    const seed = await seedOrg();
    try {
      const otherVendor = randomUUID();
      await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${otherVendor}, ${seed.orgId}, 'vendor', 'Other Vendor', true, '{}'::jsonb)`);
      const po = await seedApprovedPo(seed, "PO-M38-03", otherVendor);
      await receivePurchaseOrder(seed.orgId, seed.actorId, po.orderId, {
        receiptDate: seed.date,
        idempotencyKey: randomUUID(),
        lines: [{ sourceLineId: po.lineA, quantity: "2888" }],
      });
      const billId = randomUUID();
      const currency = (
        await db.execute<{ c: string }>(
          sql`select base_currency as c from orgs where id = ${seed.orgId}`,
          "objects",
        )
      )[0]!.c;
      await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                             status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
      values (${billId}, ${seed.orgId}, 'vendor_bill', 'BILL-M38-3', ${seed.vendorId}, ${seed.date}, ${seed.date},
              ${currency}, 'draft', ${seed.subsidiaryId}, '13193.60', '0', '13193.60', '{}'::jsonb, ${seed.actorId})
    `);
      await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
         unit_price, amount, tax_amount, stock_location_id, custom)
      values (${randomUUID()}, ${seed.orgId}, ${billId}, 1, ${seed.fifo}, ${seed.clearing},
              'Grain A', '2128', 'lb', '6.20', '13193.60', '0', ${seed.location}, '{}'::jsonb)
    `);
      await db.execute(
        sql`update documents set status = 'approved' where id = ${billId} and org_id = ${seed.orgId}`,
      );
      const dialog = await withOrg(seed.orgId, () => billMatchCandidates(seed.orgId, billId));
      assert.deepEqual(
        candidateNumbers(dialog.lines, 1),
        [],
        "a different vendor's order is never offered",
      );
      await postBill(seed, billId);
      const status = (
        await db.execute<{ status: string }>(
          sql`select status from documents where id = ${billId}`,
          "objects",
        )
      )[0]!.status;
      assert.equal(status, "posted", "an unrelated vendor's order does not block this bill");
      const otherOrder = (
        await db.execute<{ quantity_billed: string }>(
          sql`select quantity_billed::text from document_lines where org_id=${seed.orgId} and id=${po.lineA}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        toUnits(otherOrder.quantity_billed),
        0n,
        "the bill cannot consume another vendor's received cover",
      );
      const ownReceipt = (
        await db.execute<{ quantity: string }>(
          sql`
      select sum(m.quantity)::text as quantity from inventory_movements m
      join document_lines l on l.org_id=m.org_id and l.id=m.document_line_id
      where m.org_id=${seed.orgId} and l.document_id=${billId} and m.status='posted'`,
          "objects",
        )
      )[0]!;
      assert.equal(
        toUnits(ownReceipt.quantity),
        toUnits("2128"),
        "the independent bill receives its own stock",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);
