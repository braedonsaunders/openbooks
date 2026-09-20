/**
 * A source-cancelled transaction that the mirror already handled must not fail
 * the run.
 *
 * The source is the system of record for cancellation: when a previously
 * imported posted document is reported `unbuildable` with reason "cancelled",
 * the engine mirrors the deletion (original-period reversal + void) and drops
 * the ref from `deletedAtSource`. But the ref stays in `changes.unbuildable`,
 * which is counted verbatim into `sourceUnbuildable` — and any nonzero
 * `sourceUnbuildable` fails verification, so the run throws, the incremental
 * cursor never advances past the cancellation, and every later run re-pulls
 * the same terminal source state and fails again. No controller disposition
 * can clear it (resolutions are only consulted for `deletedAtSource`
 * members), so the connection is red forever with nothing left to fix.
 *
 * These cases pin the converged contract: a cancelled ref that is mirrored
 * this run, was never imported, or is already voided is financially converged
 * and must not fail verification. A cancelled ref that still stands as a live
 * local document keeps failing honestly.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type {
  MigrationSource,
  NativeChanges,
  SourceEntity,
} from "./source.ts";
import type { NativeDocument } from "./native.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Lease a fresh scratch org per top-level test. The suite's fixture lifecycle
 * hook drains forgotten leases at every top-level test boundary, so an org
 * memoized across tests is reset — and re-leased to another worker process —
 * as soon as the first test ends.
 */
async function ctx(): Promise<ScratchOrg> {
  return createScratchOrg();
}

async function newConnection(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into connections (id, org_id, source, display_name)
    values (${id}, ${orgId}, 'qbo', ${`cancelled-test-${id.slice(0, 8)}`})`);
  return id;
}

interface FakeLedger {
  openUnpaid: string | null;
}

/** Minimal adapter: one invoice, then a terminal source cancellation. */
class CancelledInvoiceSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";

  cancelled = false;
  orderMode = false;
  ledger: FakeLedger = { openUnpaid: "100" };

  constructor(private readonly o: ScratchOrg) {}

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  private invoice(): NativeDocument {
    return {
      sourceRef: "TST-1",
      kind: this.orderMode ? "sales_order" : "customer_invoice",
      posting: !this.orderMode,
      lifecycleStatus: "approved",
      partyId: this.o.customerId,
      currency: "CAD",
      fxRate: "1",
      documentDate: this.o.date,
      postingDate: this.o.date,
      postingPeriodId: this.o.periodId,
      dueDate: this.o.date,
      memo: null,
      referenceNumber: null,
      controlAccountId: null,
      subtotal: "100",
      total: "100",
      lines: [{
        accountId: this.o.accounts.revenue,
        itemId: null,
        quantity: "1",
        unitPrice: "100",
        amount: "100",
        taxAmount: "0",
        taxOverridden: false,
        taxCodeId: null,
        departmentId: null,
        projectId: null,
        description: "cancelled-mirror probe",
        lineNumber: 1,
      }],
    };
  }

  nativeChanges(): Promise<NativeChanges> {
    if (this.cancelled) {
      return Promise.resolve({
        documents: [],
        applications: [],
        deletedRefs: [],
        syncedThrough: new Date("2026-07-20T00:00:00.000Z"),
        unbuildable: [{ ref: "TST-1", reason: "cancelled" }],
      });
    }
    return Promise.resolve({
      documents: [this.invoice()],
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-16T00:00:00.000Z"),
      unbuildable: [],
    });
  }

  trialBalance(): Promise<never[]> {
    // Scratch accounts carry no the engine's scoped trial, so the engine's scoped trial
    // balance is empty on both sides by construction.
    return Promise.resolve([]);
  }

  monthlyActivity(): Promise<never[]> {
    return Promise.resolve([]);
  }

  openItems(): Promise<{ ref: string; unpaid: string }[]> {
    if (this.ledger.openUnpaid === null) return Promise.resolve([]);
    return Promise.resolve([{ ref: "TST-1", unpaid: this.ledger.openUnpaid }]);
  }
}

test(
  "a mirrored source cancellation does not fail verification",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await ctx();
    const connectionId = await newConnection(o.orgId);
    const source = new CancelledInvoiceSource(o);

    const first = await runSync(source, "cancelled-mirror-test", {
      kind: "full_migration",
      orgId: o.orgId,
      connectionId,
      since: null,
      loadEntitiesFirst: false,
    });
    assert.equal(first.docsNew, 1, "the invoice imports cleanly first");
    assert.equal(first.docsFailed, 0);

    // The source terminally cancels the invoice and drops it from open items.
    source.cancelled = true;
    source.ledger.openUnpaid = null;

    const second = await runSync(source, "cancelled-mirror-test", {
      kind: "incremental",
      orgId: o.orgId,
      connectionId,
      since: new Date("2026-07-16T00:00:00.000Z"),
      loadEntitiesFirst: false,
    });
    assert.deepEqual(second.autoResolvedDeletions, ["TST-1"]);
    assert.deepEqual(second.deletedAtSource, []);
    assert.equal(
      second.sourceUnbuildable,
      0,
      "a converged cancellation is handled work, not an unbuildable failure",
    );

    const [doc] = (await db.execute<{ status: string; open_balance: string | null }>(sql`
      select status, open_balance::text as open_balance from documents
       where org_id = ${o.orgId} and custom->>'qboId' = 'TST-1'`)).rows;
    assert.equal(doc?.status, "voided", "the mirror voids the cancelled invoice");
    assert.ok(
      doc?.open_balance === null || doc?.open_balance === "0.0000" || doc?.open_balance === "0",
      `the voided invoice carries no open balance (got ${doc?.open_balance})`,
    );
  },
);

test(
  "a cancelled source order that still stands locally keeps failing honestly",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await ctx();
    const connectionId = await newConnection(o.orgId);
    const source = new CancelledInvoiceSource(o);
    source.orderMode = true;
    // Orders carry no open-item truth: the gate only sees posted AR/AP.
    source.ledger.openUnpaid = null;

    const first = await runSync(source, "cancelled-mirror-test", {
      kind: "full_migration",
      orgId: o.orgId,
      connectionId,
      since: null,
      loadEntitiesFirst: false,
    });
    assert.equal(first.ordersNew, 1, "the order imports cleanly first");

    // The source cancels the order, but a non-posting document has no posted
    // GL to reverse, so the engine reports the divergence instead of
    // auto-voiding: the approved local order still stands against it.
    source.cancelled = true;
    source.ledger.openUnpaid = null;

    await assert.rejects(
      () =>
        runSync(source, "cancelled-mirror-test", {
          kind: "incremental",
          orgId: o.orgId,
          connectionId,
          since: new Date("2026-07-16T00:00:00.000Z"),
          loadEntitiesFirst: false,
        }),
      /1 source transactions were unbuildable/,
      "a live local order against a source cancellation must keep failing",
    );
  },
);
