import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { receiveInventory } from "../inventory/movements.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { PosError } from "./errors.ts";
import { completeRequestedDocumentVoid, requestDocumentVoid } from "../ledger/document-void.ts";
import {
  completePosRefund,
  completePosSale,
  readPosReceipt,
  type PosAuthority,
  type PosPricingDeps,
} from "./sales.ts";
import { listSessions, openSession, readSessionSummary } from "./sessions.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const SALE_INSTANT = "2026-07-15T15:00:00.000Z";
const pricing: PosPricingDeps = { unitPrice: async () => "10.0000" };
const manager: PosAuthority = { overridePrice: true, discount: true };
const cashier: PosAuthority = { overridePrice: false, discount: false };

interface Fixture {
  org: ScratchOrg;
  actorId: string;
  registerId: string;
  sessionId: string;
  unitsAccountId: string;
}

async function fixture(
  options: { noChargeUnits?: boolean; subsidiaryCurrency?: string } = {},
): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Register Manager", "register_manager"),
  );
  await withBypassContext(() =>
    grantScratchPermissions(org.orgId, actorId, [
      "pos.sell",
      "pos.refund",
      "pos.override",
      "cash_sales.create",
      "cash_sales.post",
    ]),
  );
  const registerId = randomUUID();
  const unitsAccountId = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "9100", "Units given at no charge", "statistical"),
  );
  await withBypassContext(async () => {
    if (options.subsidiaryCurrency) {
      await db.execute(sql`update orgs set base_currency = 'CAD' where id = ${org.orgId}`);
      await db.execute(
        sql`update subsidiaries set base_currency = ${options.subsidiaryCurrency} where org_id = ${org.orgId} and id = ${org.subsidiaryId}`,
      );
    }
    if (options.noChargeUnits !== false) {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{controlAccounts,noChargeUnits}', to_jsonb(${unitsAccountId}::text))
         where id = ${org.orgId}`);
    }
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"cashSales":true,"posRegister":true}'::jsonb)
       where id = ${org.orgId}`);
    await db.execute(sql`
      insert into customer_roles (org_id, party_id, created_by, updated_by)
      select ${org.orgId}, ${org.customerId}, ${actorId}, ${actorId}
       where not exists (select 1 from customer_roles where org_id = ${org.orgId} and party_id = ${org.customerId})`);
    await db.execute(sql`
      insert into pos_registers (id, org_id, code, name, subsidiary_id, location_id, stock_location_id, default_customer_id, cash_account_id, denominations)
      values (${registerId}, ${org.orgId}, 'R1', 'Front counter', ${org.subsidiaryId}, ${org.locationId}, ${org.stockLocationId}, ${org.customerId}, ${org.accounts.bank}, '{}'::text[])`);
  });
  await withOrg(org.orgId, () =>
    receiveInventory(org.orgId, actorId, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "4",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    }),
  );
  const session = await withSimClock(SALE_INSTANT, () =>
    openSession({
      orgId: org.orgId,
      actorId,
      registerId,
      openingCount: [],
      allowedSubsidiaryIds: null,
    }),
  );
  return { org, actorId, registerId, sessionId: session.id, unitsAccountId };
}

const sale = (f: Fixture, overrides: Partial<Parameters<typeof completePosSale>[0]> = {}) => ({
  orgId: f.org.orgId,
  actorId: f.actorId,
  sessionId: f.sessionId,
  idempotencyKey: randomUUID(),
  customerId: null,
  lines: [
    {
      itemId: f.org.items.fifo,
      quantity: "2",
      discount: { kind: "percent" as const, value: "100" },
    },
  ],
  payments: [],
  expectedTotal: "0.0000",
  allowedSubsidiaryIds: null,
  ...overrides,
});

async function restockedValue(f: Fixture, documentId: string): Promise<number> {
  const row = (
    await withOrg(f.org.orgId, () =>
      db.execute<{ value: string | null }>(
        sql`
    select sum(m.total_value)::text as value
      from inventory_movements m
      join document_lines l on l.org_id = m.org_id and l.id = m.document_line_id
     where m.org_id = ${f.org.orgId} and l.document_id = ${documentId} and m.kind = 'receipt'`,
        "objects",
      ),
    )
  )[0];
  return Number(row?.value ?? 0);
}

function refusedWith(code: string) {
  return (error: unknown) => error instanceof PosError && error.code === code;
}

test(
  "a sale discounted in full completes with no tender: a posted cash sale, inventory relieved at cost, a no-charge receipt",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const completion = await withSimClock(SALE_INSTANT, () =>
        completePosSale(sale(f), manager, pricing),
      );
      assert.equal(completion.total, "0.0000");
      assert.equal(completion.change, "0.0000");
      assert.equal(completion.replayed, false);

      const doc = (
        await withOrg(f.org.orgId, () =>
          db.execute<{
            kind: string;
            status: string;
            total: string;
            posted_entry_id: string | null;
          }>(
            sql`
      select kind, status, total::text as total, posted_entry_id from documents where org_id = ${f.org.orgId} and id = ${completion.documentId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual([doc.kind, doc.status, doc.total], ["cash_sale", "posted", "0.0000"]);
      assert.ok(doc.posted_entry_id, "the sale keeps its exact journal identity");

      // The sale's own entry moves no money: one statistical measurement of the units given.
      const legs = await withOrg(f.org.orgId, () =>
        db.execute<{
          account_id: string;
          amount: string;
          quantity: string | null;
          unit: string | null;
          is_open_item: boolean;
        }>(
          sql`
      select account_id, amount::text as amount, quantity::text as quantity, unit, is_open_item
        from journal_lines where org_id = ${f.org.orgId} and entry_id = ${doc.posted_entry_id} order by line_number`,
          "objects",
        ),
      );
      assert.equal(legs.length, 1);
      assert.equal(legs[0]!.account_id, f.unitsAccountId);
      assert.equal(Number(legs[0]!.amount), 0);
      assert.equal(Number(legs[0]!.quantity), 2);
      assert.equal(legs[0]!.is_open_item, false);

      const tenders = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from document_tenders where org_id = ${f.org.orgId} and document_id = ${completion.documentId}`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(tenders, 0);

      // Inventory relief still runs: two units leave stock at their FIFO cost.
      const issue = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ quantity: string; value: string }>(
            sql`
      select sum(m.quantity)::text as quantity, sum(m.total_value)::text as value
        from inventory_movements m
        join document_lines l on l.org_id = m.org_id and l.id = m.document_line_id
       where m.org_id = ${f.org.orgId} and l.document_id = ${completion.documentId} and m.kind = 'issue'`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(Math.abs(Number(issue.quantity)), 2);
      assert.equal(Math.abs(Number(issue.value)), 8);

      const attribution = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ total_minor: string; cash_applied_minor: string; change_minor: string }>(
            sql`
      select total_minor::text, cash_applied_minor::text, change_minor::text from pos_transactions
       where org_id = ${f.org.orgId} and document_id = ${completion.documentId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(
        [attribution.total_minor, attribution.cash_applied_minor, attribution.change_minor],
        ["0", "0", "0"],
      );

      const audit = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from audit_log where org_id = ${f.org.orgId} and row_id = ${completion.documentId} and table_name = 'documents'`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.ok(audit >= 2, "the sale's submission and posting are audited");

      const receipt = await withOrg(f.org.orgId, () =>
        readPosReceipt(db, f.org.orgId, completion.documentId, null),
      );
      assert.equal(receipt.total, "0.0000");
      assert.deepEqual(receipt.tenders, []);
      assert.equal(receipt.lines[0]!.discount, "20.0000");

      const summary = await withOrg(f.org.orgId, () =>
        readSessionSummary(db, f.org.orgId, f.sessionId, null),
      );
      assert.equal(summary.saleCount, 1);
      assert.equal(summary.noChargeSaleCount, 1);
      assert.equal(summary.salesTotalMinor, 0n);
      assert.equal(summary.saleCashMinor, 0n);

      // A retry with the same key returns the sale already recorded.
      const replay = await withSimClock(SALE_INSTANT, () =>
        completePosSale(sale(f, { idempotencyKey: completion.documentId }), manager, pricing),
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.documentId, completion.documentId);

      // Refunding the comped units pays nothing back and restocks them.
      const refund = await withSimClock(SALE_INSTANT, () =>
        completePosRefund({
          orgId: f.org.orgId,
          actorId: f.actorId,
          sessionId: f.sessionId,
          idempotencyKey: randomUUID(),
          originalDocumentId: completion.documentId,
          lines: [{ lineNumber: 1, quantity: "2" }],
          payments: [],
          reason: "Returned unopened",
          allowedSubsidiaryIds: null,
        }),
      );
      assert.equal(refund.total, "0.0000");
      const refundDoc = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ status: string; posted_entry_id: string }>(
            sql`
      select status, posted_entry_id from documents where org_id = ${f.org.orgId} and id = ${refund.documentId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(refundDoc.status, "posted");
      const refundLegs = await withOrg(f.org.orgId, () =>
        db.execute<{ quantity: string }>(
          sql`
      select quantity::text as quantity from journal_lines where org_id = ${f.org.orgId} and entry_id = ${refundDoc.posted_entry_id}`,
          "objects",
        ),
      );
      assert.deepEqual(
        refundLegs.map((leg) => Number(leg.quantity)),
        [-2],
      );
      assert.equal(
        await restockedValue(f, refund.documentId),
        8,
        "the returned units come back at the cost they left at",
      );
      const after = await withOrg(f.org.orgId, () =>
        readSessionSummary(db, f.org.orgId, f.sessionId, null),
      );
      assert.equal(after.noChargeRefundCount, 1);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test("a full discount needs the register override permission", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      withSimClock(SALE_INSTANT, () => completePosSale(sale(f), cashier, pricing)),
      refusedWith("discount_not_permitted"),
    );
    const docs = (
      await withOrg(f.org.orgId, () =>
        db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from documents where org_id = ${f.org.orgId} and kind = 'cash_sale'`,
          "objects",
        ),
      )
    )[0]!.n;
    assert.equal(docs, 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test(
  "voided POS sales do not count toward session totals or expected cash",
  { skip: !DB },
  async () => {
    const f = await fixture();
    let stage = "preparing the service item";
    try {
      const serviceItem = await withBypassContext(() =>
        db.execute<{ id: string }>(
          sql`
      update items set recognition_rule_id = null, deferred_account_id = null
       where org_id = ${f.org.orgId} and id = ${f.org.items.service}
       returning id`,
          "objects",
        ),
      );
      assert.equal(serviceItem.length, 1, "the sale fixture uses a non-recurring service item");
      stage = "completing the sale";
      const sold = await withSimClock(SALE_INSTANT, () =>
        completePosSale(
          sale(f, {
            lines: [{ itemId: f.org.items.service, quantity: "1" }],
            payments: [{ kind: "cash", tendered: "10.00" }],
            expectedTotal: "10.0000",
          }),
          cashier,
          pricing,
        ),
      );
      assert.equal(sold.total, "10.0000");

      stage = "requesting the void";
      const requested = await withOrg(f.org.orgId, () =>
        requestDocumentVoid({
          documentId: sold.documentId,
          orgId: f.org.orgId,
          actorId: f.actorId,
          reason: "Sale entered in error",
          reversalDate: f.org.date,
          source: "api",
        }),
      );
      assert.equal(requested.status, "voided");
      stage = "completing the void";
      await withOrg(f.org.orgId, () =>
        completeRequestedDocumentVoid(sold.documentId, f.org.orgId, null),
      );

      stage = "reading the session summary";
      const summary = await withOrg(f.org.orgId, () =>
        readSessionSummary(db, f.org.orgId, f.sessionId, null),
      );
      assert.deepEqual(
        [
          summary.saleCount,
          summary.salesTotalMinor,
          summary.saleCashMinor,
          summary.expectedCashMinor,
        ],
        [0, 0n, 0n, 0n],
      );
      stage = "listing the session";
      const sessions = await withOrg(f.org.orgId, () =>
        listSessions(db, f.org.orgId, { registerId: f.registerId }, null),
      );
      assert.deepEqual([sessions.rows[0]?.saleCount, sessions.rows[0]?.salesTotalMinor], [0, "0"]);
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message.replace(/\s+/g, " ")}; cause: ${error.cause instanceof Error ? error.cause.message.replace(/\s+/g, " ") : String(error.cause ?? "")}`
          : String(error);
      assert.fail(`Voided POS sales scenario failed while ${stage}: ${detail}`);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "registers use their subsidiary currency for sessions and POS documents",
  { skip: !DB },
  async () => {
    const f = await fixture({ subsidiaryCurrency: "USD" });
    try {
      const sessionCurrency = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ currency: string }>(
            sql`
      select currency from pos_sessions where org_id = ${f.org.orgId} and id = ${f.sessionId}`,
            "objects",
          ),
        )
      )[0]?.currency;
      assert.equal(sessionCurrency, "USD");
      const sold = await withSimClock(SALE_INSTANT, () =>
        completePosSale(
          sale(f, {
            lines: [{ itemId: f.org.items.fifo, quantity: "1" }],
            payments: [{ kind: "cash", tendered: "10.00" }],
            expectedTotal: "10.0000",
          }),
          cashier,
          pricing,
        ),
      );
      const currency = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ currency: string }>(
            sql`
      select currency from documents where org_id = ${f.org.orgId} and id = ${sold.documentId}`,
            "objects",
          ),
        )
      )[0]?.currency;
      assert.equal(currency, "USD");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a zero-total sale takes no payment, and a sale with an amount due still needs one",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        withSimClock(SALE_INSTANT, () =>
          completePosSale(
            sale(f, { payments: [{ kind: "cash", tendered: "5.00" }] }),
            manager,
            pricing,
          ),
        ),
        refusedWith("tender_mismatch"),
      );
      await assert.rejects(
        withSimClock(SALE_INSTANT, () =>
          completePosSale(
            sale(f, {
              lines: [{ itemId: f.org.items.fifo, quantity: "1" }],
              expectedTotal: "10.0000",
            }),
            manager,
            pricing,
          ),
        ),
        refusedWith("tender_mismatch"),
      );
      const docs = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from documents where org_id = ${f.org.orgId} and kind = 'cash_sale'`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(docs, 0, "a refused sale leaves nothing behind");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a comped sale is refused, leaving nothing behind, until the No-charge units account is configured",
  { skip: !DB },
  async () => {
    const f = await fixture({ noChargeUnits: false });
    try {
      await assert.rejects(
        withSimClock(SALE_INSTANT, () => completePosSale(sale(f), manager, pricing)),
        (error: unknown) =>
          error instanceof Error && /No-charge units account in Setup/.test(error.message),
      );
      const docs = (
        await withOrg(f.org.orgId, () =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from documents where org_id = ${f.org.orgId} and kind = 'cash_sale'`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(docs, 0);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a register refund of stocked goods pays back the tender and restocks from the sale's own issue",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const sold = await withSimClock(SALE_INSTANT, () =>
        completePosSale(
          sale(f, {
            lines: [{ itemId: f.org.items.fifo, quantity: "3" }],
            payments: [{ kind: "cash", tendered: "40.00" }],
            expectedTotal: "30.0000",
          }),
          cashier,
          pricing,
        ),
      );
      assert.equal(sold.change, "10.0000");
      const refund = await withSimClock(SALE_INSTANT, () =>
        completePosRefund({
          orgId: f.org.orgId,
          actorId: f.actorId,
          sessionId: f.sessionId,
          idempotencyKey: randomUUID(),
          originalDocumentId: sold.documentId,
          lines: [{ lineNumber: 1, quantity: "1" }],
          payments: [{ kind: "cash" }],
          reason: null,
          allowedSubsidiaryIds: null,
        }),
      );
      assert.equal(refund.total, "10.0000");
      assert.equal(await restockedValue(f, refund.documentId), 4);
      const summary = await withOrg(f.org.orgId, () =>
        readSessionSummary(db, f.org.orgId, f.sessionId, null),
      );
      assert.equal(summary.noChargeSaleCount, 0);
      assert.equal(summary.saleCashMinor - summary.refundCashMinor, 200000n);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "successive partial refunds allocate the full original line amount",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const salePricing: PosPricingDeps = { unitPrice: async () => "3.3333" };
      const sold = await withSimClock(SALE_INSTANT, () =>
        completePosSale(
          sale(f, {
            lines: [{ itemId: f.org.items.fifo, quantity: "3" }],
            payments: [{ kind: "cash", tendered: "10.00" }],
            expectedTotal: "10.0000",
          }),
          manager,
          salePricing,
        ),
      );

      const refundTotals: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const refund = await withSimClock(SALE_INSTANT, () =>
          completePosRefund({
            orgId: f.org.orgId,
            actorId: f.actorId,
            sessionId: f.sessionId,
            idempotencyKey: randomUUID(),
            originalDocumentId: sold.documentId,
            lines: [{ lineNumber: 1, quantity: "1" }],
            payments: [{ kind: "cash" }],
            reason: null,
            allowedSubsidiaryIds: null,
          }),
        );
        refundTotals.push(refund.total);
      }

      assert.deepEqual(refundTotals, ["3.3300", "3.3400", "3.3300"]);
      const receipt = await withOrg(f.org.orgId, () =>
        readPosReceipt(db, f.org.orgId, sold.documentId, null),
      );
      assert.equal(receipt.lines[0]!.refundedQuantity, "3.0000");
      assert.equal(receipt.lines[0]!.refundableQuantity, "0.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);
