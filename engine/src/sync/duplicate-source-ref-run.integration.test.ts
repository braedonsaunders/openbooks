/**
 * A source pull must never contain the same external id twice without the
 * engine saying so.
 *
 * `runSync` keyed everything by sourceRef but never checked the pull itself:
 * when one pull carried two documents with the same sourceRef, the second
 * silently overwrote the first through the amend path. For non-posting
 * documents that never converges — every run amends first-to-second and back,
 * so `docsAmended` grows forever, lines are deleted and re-inserted every
 * run, and no run ever reports the document unchanged. For posting documents
 * with differing copies the second amend fails closed, which fails the whole
 * run; with a stalled cursor the same duplicated pull then fails every later
 * run too. (Master data already fails closed on this: `loadEntities` throws
 * on a duplicate connector identity. The transaction pull had no equivalent.)
 *
 * These cases pin first-wins with an explicit skip note: the first occurrence
 * is applied, later ones are reported in `skipped` and change nothing, so a
 * repeated duplicated pull converges instead of churning or wedging.
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
    values (${id}, ${orgId}, 'qbo', ${`dup-test-${id.slice(0, 8)}`})`);
  return id;
}

/** Adapter that emits the same external id twice with different content. */
class DuplicateRefSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";

  /** When true the duplicated pull carries posting invoices, else orders. */
  posting = false;

  constructor(private readonly o: ScratchOrg) {}

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  private doc(total: string): NativeDocument {
    return {
      sourceRef: "TST-DUP",
      kind: this.posting ? "customer_invoice" : "sales_order",
      posting: this.posting,
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
      subtotal: total,
      total,
      lines: [{
        accountId: this.o.accounts.revenue,
        itemId: null,
        quantity: "1",
        unitPrice: total,
        amount: total,
        taxAmount: "0",
        taxOverridden: false,
        taxCodeId: null,
        departmentId: null,
        projectId: null,
        description: "duplicate-ref probe",
        lineNumber: 1,
      }],
    };
  }

  nativeChanges(): Promise<NativeChanges> {
    return Promise.resolve({
      documents: [this.doc("100"), this.doc("200")],
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-20T00:00:00.000Z"),
      unbuildable: [],
    });
  }

  trialBalance(): Promise<never[]> {
    // Scratch accounts carry no qbo ref, so the engine's scoped trial
    // balance is empty on both sides by construction.
    return Promise.resolve([]);
  }

  monthlyActivity(): Promise<never[]> {
    return Promise.resolve([]);
  }

  openItems(): Promise<{ ref: string; unpaid: string }[]> {
    // First copy wins: the live source invoice stands at 100.
    if (!this.posting) return Promise.resolve([]);
    return Promise.resolve([{ ref: "TST-DUP", unpaid: "100" }]);
  }
}

function syncOpts(o: ScratchOrg, connectionId: string, first: boolean) {
  return {
    kind: (first ? "full_migration" : "incremental") as
      | "full_migration"
      | "incremental",
    orgId: o.orgId,
    connectionId,
    since: first ? null : new Date("2026-07-16T00:00:00.000Z"),
    loadEntitiesFirst: false as const,
  };
}

test(
  "a duplicated order pull converges instead of amending forever",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await ctx();
    const connectionId = await newConnection(o.orgId);
    const source = new DuplicateRefSource(o);

    const first = await runSync(source, "dup-test", syncOpts(o, connectionId, true));
    assert.equal(first.docsFailed, 0);

    const second = await runSync(source, "dup-test", syncOpts(o, connectionId, false));
    assert.equal(
      second.docsAmended,
      0,
      "re-pulling the same duplicated pull must not amend anything",
    );
    assert.equal(second.docsUnchanged, 1);
    assert.ok(
      second.skipped.some((note) => /TST-DUP.*duplicate/i.test(note)),
      `the ignored repeat must be reported, got: ${JSON.stringify(second.skipped)}`,
    );

    const [doc] = (await db.execute<{ total: string }>(sql`
      select total::text as total from documents
       where org_id = ${o.orgId} and custom->>'qboId' = 'TST-DUP'`)).rows;
    assert.equal(doc?.total, "100.0000", "the first occurrence wins deterministically");
  },
);

test(
  "a duplicated invoice pull applies the first copy and stays green",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await ctx();
    const connectionId = await newConnection(o.orgId);
    const source = new DuplicateRefSource(o);
    source.posting = true;

    const result = await runSync(source, "dup-test", syncOpts(o, connectionId, true));
    assert.equal(result.docsNew, 1, "the first copy posts");
    assert.equal(result.docsFailed, 0, "the conflicting repeat must not fail the run");
    assert.ok(
      result.skipped.some((note) => /TST-DUP.*duplicate/i.test(note)),
      `the ignored repeat must be reported, got: ${JSON.stringify(result.skipped)}`,
    );

    const [doc] = (await db.execute<{ status: string; total: string }>(sql`
      select status, total::text as total from documents
       where org_id = ${o.orgId} and custom->>'qboId' = 'TST-DUP'`)).rows;
    assert.equal(doc?.status, "posted");
    assert.equal(doc?.total, "100.0000", "the open-item truth (100) matches the kept copy");
  },
);
