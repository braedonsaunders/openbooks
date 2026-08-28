import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  postDocument,
  PostingError,
  RULES,
  type PostingDocument,
  type PostingDocumentLine,
} from "./posting.ts";
import {
  intercompanyBalancingLegs,
  SubsidiaryError,
  type SubsidiaryContext,
  uuidArray,
} from "./subsidiaries.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("uuid-array binding rejects a nullish element instead of emitting a hole", () => {
  const accountId = randomUUID();
  assert.equal(uuidArray([accountId]), `{${accountId}}`);
  assert.throws(
    () => uuidArray([accountId, null]),
    (error: unknown) =>
      error instanceof SubsidiaryError && /element 2/.test(error.message),
  );
});

test("intercompany FX residual keeps the origin leg transaction amount in document currency", async () => {
  const originSubId = randomUUID();
  const counterSubId = randomUUID();
  const originDueFrom = randomUUID();
  const counterDueTo = randomUUID();
  const fxRate = "0.3333333333";
  const ctx: SubsidiaryContext = {
    byId: new Map([
      [originSubId, {
        id: originSubId,
        parentId: null,
        name: "Origin",
        baseCurrency: "CAD",
        isElimination: false,
        isActive: true,
      }],
      [counterSubId, {
        id: counterSubId,
        parentId: originSubId,
        name: "Counter",
        baseCurrency: "USD",
        isElimination: false,
        isActive: true,
      }],
    ]),
    rootId: originSubId,
    multi: true,
  };
  const runner = {
    execute: async () => ({
      rows: [{
        fromId: originSubId,
        toId: counterSubId,
        dueFrom: originDueFrom,
        dueTo: counterDueTo,
      }],
    }),
  } as unknown as Pick<typeof db, "execute">;
  const legs = await intercompanyBalancingLegs(runner, {
    orgId: randomUUID(),
    ctx,
    originSubId,
    originFxRate: fxRate,
    lines: [
      {
        accountId: randomUUID(),
        amount: "-33.3334",
        currency: "EUR",
        txnAmount: "-100",
        fxRate,
        subsidiaryId: originSubId,
      },
      {
        accountId: randomUUID(),
        amount: "100",
        currency: "EUR",
        txnAmount: "100",
        fxRate: "1",
        subsidiaryId: counterSubId,
      },
    ],
  });

  assert.deepEqual(legs, [
    {
      accountId: counterDueTo,
      amount: "-100.0000",
      currency: "EUR",
      txnAmount: "-100.0000",
      fxRate: "1",
      subsidiaryId: counterSubId,
      memo: "Intercompany with Origin",
    },
    {
      accountId: originDueFrom,
      amount: "33.3334",
      currency: "EUR",
      txnAmount: "100.0000",
      fxRate,
      subsidiaryId: originSubId,
      memo: "Intercompany with Counter",
    },
  ]);
});

test("an unresolved inventory account is named at the posting-rule boundary", () => {
  const doc = {
    id: "bill",
    kind: "vendor_bill",
    partyId: "vendor",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  } as unknown as PostingDocument;
  const line = {
    id: "inventory-line",
    lineNumber: 7,
    accountId: null,
    amount: "20.0000",
    taxAmount: "0",
  } as unknown as PostingDocumentLine;

  assert.throws(
    () =>
      RULES.vendor_bill!(doc, [line], {
        control: { ap: "ap", ar: "ar", bank: "bank" },
        inventoryAssetByLine: new Map(),
      }),
    (error: unknown) =>
      error instanceof PostingError &&
      /document line 7/.test(error.message) &&
      /no resolvable account/.test(error.message),
  );
});

test(
  "a document line with no resolvable account refuses posting without a partial journal",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const itemId = randomUUID();
      const documentId = randomUUID();
      const lineId = randomUUID();
      await db.execute(sql`
        insert into items
          (id, org_id, kind, name, show_on_timesheet, is_active, custom,
           create_plans_on, revenue_allocation, income_account_id)
        values (${itemId}, ${org.orgId}, 'inventory', 'Unconfigured Widget',
                false, true, '{}'::jsonb, 'billing', 'normal', null)`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, custom)
        values (${documentId}, ${org.orgId}, 'vendor_bill',
                'BILL-NO-RESOLVABLE-ACCOUNT', ${org.vendorId}, null,
                ${org.date}, ${org.date}, 'CAD', 1, 'draft',
                '20', '0', '20', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id,
           quantity, unit_price, amount, tax_amount, is_billable,
           quantity_fulfilled, quantity_billed, stock_location_id, custom,
           tax_overridden)
        values (${lineId}, ${org.orgId}, ${documentId}, 1, ${itemId}, null,
                '10', '2', '20', '0', false, '0', '0', null, '{}'::jsonb,
                false)`);

      await db.execute(sql`
        update documents
           set status = 'approved', updated_at = now()
         where id = ${documentId} and org_id = ${org.orgId}
      `);

      const deps = {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      };
      await assert.rejects(
        () => postDocument(documentId, deps),
        (error: unknown) =>
          error instanceof PostingError &&
          /document line 1/.test(error.message) &&
          /no resolvable account/.test(error.message),
      );

      const residue = (await db.execute<{
        status: string;
        entries: number;
        journalLines: number;
      }>(sql`
        select d.status,
               count(distinct e.id)::int as entries,
               count(jl.id)::int as "journalLines"
          from documents d
          left join journal_entries e
            on e.org_id = d.org_id and e.source_document_id = d.id
          left join journal_lines jl
            on jl.org_id = e.org_id and jl.entry_id = e.id
         where d.org_id = ${org.orgId} and d.id = ${documentId}
         group by d.id`)).rows[0]!;
      assert.deepEqual(residue, {
        status: "approved",
        entries: 0,
        journalLines: 0,
      });

      // Repair the inventory item's account/location resolution and prove the
      // same approved document follows the ordinary posting path.
      await db.execute(sql`
        insert into item_inventory_profiles
          (id, org_id, item_id, costing_method, tracking, asset_account_id,
           cogs_account_id, adjustment_account_id, variance_account_id,
           received_not_billed_account_id, base_unit, unit_conversions)
        values (${randomUUID()}, ${org.orgId}, ${itemId}, 'fifo', 'none',
                ${org.accounts.invAsset}, ${org.accounts.cogs},
                ${org.accounts.adjustment}, ${org.accounts.adjustment},
                ${org.accounts.clearing}, 'ea', '{}'::jsonb)`);
      await db.execute(sql`
        update documents
           set status = 'draft', updated_at = now()
         where org_id = ${org.orgId} and id = ${documentId}
      `);
      await db.execute(sql`
        update document_lines
           set stock_location_id = ${org.stockLocationId}
         where org_id = ${org.orgId} and id = ${lineId}`);
      await db.execute(sql`
        update documents
           set status = 'approved', updated_at = now()
         where org_id = ${org.orgId} and id = ${documentId}
      `);

      assert.ok(await postDocument(documentId, deps));
      const posted = (await db.execute<{
        status: string;
        entries: number;
        journalLines: number;
      }>(sql`
        select d.status,
               count(distinct e.id)::int as entries,
               count(jl.id)::int as "journalLines"
          from documents d
          left join journal_entries e
            on e.org_id = d.org_id and e.source_document_id = d.id
          left join journal_lines jl
            on jl.org_id = e.org_id and jl.entry_id = e.id
         where d.org_id = ${org.orgId} and d.id = ${documentId}
         group by d.id`)).rows[0]!;
      assert.deepEqual(posted, {
        status: "posted",
        entries: 1,
        journalLines: 2,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
