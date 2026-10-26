/**
 * A connected source's vendor bill keeps the number its vendor issued.
 *
 * Vendors number independently, so two vendors' bills may both be "764".
 * Document numbers for vendor bills and credits are unique per vendor, so the
 * mirror suffixes a source number with its immutable source id only when the
 * SAME vendor already holds it, and a re-sync returns a document stored under
 * the suffixed form to its clean number once that number is free for its
 * vendor — audited, and without touching the posted journal.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type { MigrationSource, NativeChanges, SourceEntity } from "./source.ts";
import type { NativeDocument } from "./native.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function newConnection(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into connections (id, org_id, source, display_name)
    values (${id}, ${orgId}, 'qbo', ${`vendor-numbers-${id.slice(0, 8)}`})`);
  return id;
}

async function secondVendor(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'vendor', 'Second Vendor', true, '{}'::jsonb)`);
  return id;
}

type Bill = { ref: string; partyId: string; number: string; amount: string };

/** A source whose pull is exactly the posted vendor bills it is given. */
class VendorBillSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";

  constructor(
    private readonly o: ScratchOrg,
    private readonly bills: Bill[],
  ) {}

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  private doc(bill: Bill): NativeDocument {
    return {
      sourceRef: bill.ref,
      documentNumber: bill.number,
      kind: "vendor_bill",
      posting: true,
      partyId: bill.partyId,
      currency: "CAD",
      fxRate: "1",
      documentDate: this.o.date,
      postingDate: this.o.date,
      postingPeriodId: this.o.periodId,
      dueDate: this.o.date,
      memo: null,
      referenceNumber: bill.number,
      controlAccountId: null,
      lines: [
        {
          accountId: this.o.accounts.cogs,
          itemId: null,
          quantity: "1",
          unitPrice: bill.amount,
          amount: bill.amount,
          taxAmount: "0",
          taxOverridden: false,
          taxCodeId: null,
          departmentId: null,
          projectId: null,
          description: "vendor number probe",
          lineNumber: 1,
        },
      ],
    };
  }

  nativeChanges(): Promise<NativeChanges> {
    return Promise.resolve({
      documents: this.bills.map((bill) => this.doc(bill)),
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-20T00:00:00.000Z"),
      unbuildable: [],
    });
  }

  trialBalance(): Promise<never[]> {
    return Promise.resolve([]);
  }

  monthlyActivity(): Promise<never[]> {
    return Promise.resolve([]);
  }

  openItems(): Promise<{ ref: string; unpaid: string }[]> {
    return Promise.resolve(this.bills.map((bill) => ({ ref: bill.ref, unpaid: bill.amount })));
  }
}

const fullRun = (o: ScratchOrg, connectionId: string) => ({
  kind: "full_migration" as const,
  orgId: o.orgId,
  connectionId,
  since: null,
  loadEntitiesFirst: false as const,
});

async function numbersByRef(orgId: string): Promise<Record<string, string>> {
  const rows = await db.execute<{ ref: string; number: string }>(
    sql`
    select custom->>'qboId' as ref, document_number as number
      from documents
     where org_id = ${orgId} and custom ? 'qboId'`,
    "objects",
  );
  return Object.fromEntries(rows.map((row) => [row.ref, row.number]));
}

test(
  "another vendor's identical bill number keeps its clean number; the same vendor's repeat is suffixed",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await createScratchOrg();
    const connectionId = await newConnection(o.orgId);
    const other = await secondVendor(o.orgId);
    const source = new VendorBillSource(o, [
      { ref: "B1", partyId: o.vendorId, number: "764", amount: "100" },
      { ref: "B2", partyId: other, number: "764", amount: "200" },
      { ref: "B3", partyId: o.vendorId, number: "764", amount: "300" },
    ]);

    const result = await runSync(source, "vendor-numbers-test", fullRun(o, connectionId));
    assert.equal(result.docsFailed, 0, JSON.stringify(result.skipped));
    assert.equal(result.docsNew, 3);
    assert.deepEqual(await numbersByRef(o.orgId), {
      B1: "764",
      B2: "764",
      B3: "764 [qbo:B3]",
    });
  },
);

test(
  "a re-sync restores a number suffixed only for another vendor's collision, audited, with the posted journal untouched",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await createScratchOrg();
    const connectionId = await newConnection(o.orgId);
    const other = await secondVendor(o.orgId);
    const source = new VendorBillSource(o, [
      { ref: "B1", partyId: o.vendorId, number: "764", amount: "100" },
      { ref: "B2", partyId: other, number: "764", amount: "200" },
      { ref: "B3", partyId: o.vendorId, number: "764", amount: "300" },
    ]);
    const first = await runSync(source, "vendor-numbers-test", fullRun(o, connectionId));
    assert.equal(first.docsFailed, 0, JSON.stringify(first.skipped));

    // An install that imported under organization-wide numbering holds the
    // other vendor's bill under the collision-safe form.
    const [b2] = await db.execute<{ id: string; posted_entry_id: string }>(
      sql`
      select id, posted_entry_id from documents
       where org_id = ${o.orgId} and custom->>'qboId' = 'B2'`,
      "objects",
    );
    assert.ok(b2?.posted_entry_id, "the other vendor's bill is posted");
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local openbooks.amend = on`);
      await tx.execute(sql`set local openbooks.migration = on`);
      const updated = await tx.execute(
        sql`
        update documents set document_number = '764 [qbo:B2]'
         where id = ${b2.id} and org_id = ${o.orgId} returning id`,
        "objects",
      );
      assert.equal(updated.length, 1);
    });
    const journalBefore = await db.execute(
      sql`
      select account_id, amount::text, party_id, is_open_item
        from journal_lines
       where org_id = ${o.orgId} and entry_id = ${b2.posted_entry_id}
       order by id`,
      "objects",
    );

    const second = await runSync(source, "vendor-numbers-test", fullRun(o, connectionId));
    assert.equal(second.docsFailed, 0, JSON.stringify(second.skipped));
    assert.equal(second.docsAmended, 1, "only the cross-vendor collision is renumbered");
    assert.equal(second.docsUnchanged, 2, "the same vendor's genuine duplicate keeps its suffix");
    assert.deepEqual(await numbersByRef(o.orgId), {
      B1: "764",
      B2: "764",
      B3: "764 [qbo:B3]",
    });

    const [after] = await db.execute<{ posted_entry_id: string; status: string }>(
      sql`
      select posted_entry_id, status from documents
       where id = ${b2.id} and org_id = ${o.orgId}`,
      "objects",
    );
    assert.equal(after?.posted_entry_id, b2.posted_entry_id, "the posted entry is the same entry");
    assert.equal(after?.status, "posted");
    const journalAfter = await db.execute(
      sql`
      select account_id, amount::text, party_id, is_open_item
        from journal_lines
       where org_id = ${o.orgId} and entry_id = ${b2.posted_entry_id}
       order by id`,
      "objects",
    );
    assert.deepEqual(journalAfter, journalBefore, "the posted journal lines are unchanged");

    const audits = await db.execute<{ reason: string; before: string; after: string }>(
      sql`
      select changes->>'reason' as reason,
             changes->'before'->'document'->>'document_number' as before,
             changes->'after'->'document'->>'document_number' as after
        from audit_log
       where org_id = ${o.orgId} and table_name = 'documents' and row_id = ${b2.id}
         and changes->>'reason' = 'source_transaction_number_changed'`,
      "objects",
    );
    assert.deepEqual(audits, [
      {
        reason: "source_transaction_number_changed",
        before: "764 [qbo:B2]",
        after: "764",
      },
    ]);

    const third = await runSync(source, "vendor-numbers-test", fullRun(o, connectionId));
    assert.equal(third.docsAmended, 0, "a restored number is stable on the next run");
    assert.equal(third.docsUnchanged, 3);
  },
);
