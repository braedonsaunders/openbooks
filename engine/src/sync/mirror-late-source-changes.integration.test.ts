import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type { MigrationSource, NativeChanges, SourceEntity } from "./source.ts";
import type { NativeDocument } from "./native.ts";
import type { SyncResult } from "./sync-result.ts";
import { SyncVerificationError } from "./sync-verification-state.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const FIRST_CUTOFF = new Date("2026-07-20T10:00:00.000Z");

/**
 * A source whose first pull returns the transactions known when the run
 * started; later pulls return what was entered while the run was in flight.
 * Its open items always describe the source as it stands now.
 */
class InFlightSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";
  readonly pulls: (Date | null)[] = [];

  constructor(
    private readonly o: ScratchOrg,
    private readonly batches: string[][],
    private readonly openRefs: string[],
  ) {}

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  nativeChanges(since: Date | null): Promise<NativeChanges> {
    const call = this.pulls.length;
    this.pulls.push(since);
    const refs = this.batches[call] ?? [];
    return Promise.resolve({
      documents: refs.map((ref) => this.invoice(ref)),
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date(FIRST_CUTOFF.getTime() + call * 60_000),
      unbuildable: [],
    });
  }

  private invoice(ref: string): NativeDocument {
    return {
      sourceRef: ref,
      kind: "customer_invoice",
      posting: true,
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
      lines: [
        {
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
          description: `source ${ref}`,
          lineNumber: 1,
        },
      ],
    };
  }

  trialBalance(): Promise<never[]> {
    return Promise.resolve([]);
  }

  monthlyActivity(): Promise<never[]> {
    return Promise.resolve([]);
  }

  openItems(): Promise<{ ref: string; unpaid: string }[]> {
    return Promise.resolve(this.openRefs.map((ref) => ({ ref, unpaid: "100" })));
  }
}

async function mirror(
  o: ScratchOrg,
  connectionId: string,
  source: InFlightSource,
): Promise<SyncResult> {
  try {
    return await runSync(source, "late-probe", {
      kind: "incremental",
      orgId: o.orgId,
      connectionId,
      since: new Date("2026-07-01T00:00:00.000Z"),
      loadEntitiesFirst: false as const,
    });
  } catch (error) {
    if (error instanceof SyncVerificationError) return error.result;
    throw error;
  }
}

async function scenario(run: (o: ScratchOrg, connectionId: string) => Promise<void>) {
  const o = await createScratchOrg();
  try {
    const connectionId = randomUUID();
    await db.execute(sql`
      insert into connections (id, org_id, source, display_name, status)
      values (${connectionId}, ${o.orgId}, 'qbo', 'late-probe', 'active')`);
    await run(o, connectionId);
  } finally {
    await dropScratchOrg(o.orgId);
  }
}

async function mirroredRefs(o: ScratchOrg): Promise<string[]> {
  const rows = await db.execute<{ ref: string }>(
    sql`select custom->>'qboId' as ref from documents
         where org_id = ${o.orgId} and custom->>'qboId' is not null and posted_entry_id is not null
         order by 1`,
    "objects",
  );
  return rows.map((row) => row.ref);
}

test(
  "a transaction entered at the source during a run is applied before verification",
  { skip: !DB, timeout: 240_000 },
  async () => {
    await scenario(async (o, connectionId) => {
      const source = new InFlightSource(o, [["EARLY-1"], ["LATE-1"], []], ["EARLY-1", "LATE-1"]);
      const result = await mirror(o, connectionId, source);
      assert.equal(result.docsFailed, 0, result.skipped.join("\n"));
      assert.equal(result.docsNew, 2);
      assert.deepEqual(result.openItems?.mismatches ?? [], []);
      assert.deepEqual(await mirroredRefs(o), ["EARLY-1", "LATE-1"]);
      // The late pass reads only what changed after the first cutoff.
      assert.deepEqual(source.pulls.slice(1), [FIRST_CUTOFF]);
      const state = await db.execute<{ status: string; cursor: string; synced: string }>(
        sql`select r.status, c.cursor::text as cursor, r.synced_through::text as synced
              from sync_runs r join connections c on c.id = r.connection_id
             where r.id = ${result.runId}`,
        "objects",
      );
      // The watermark stays at the first pull, so the next run re-reads the late transaction.
      assert.equal(state[0]?.status, "ok");
      assert.equal(new Date(state[0]!.cursor).getTime(), FIRST_CUTOFF.getTime());
      assert.equal(new Date(state[0]!.synced).getTime(), FIRST_CUTOFF.getTime());
    });
  },
);

test(
  "a difference that persists with no further source changes still refuses",
  { skip: !DB, timeout: 240_000 },
  async () => {
    await scenario(async (o, connectionId) => {
      const source = new InFlightSource(o, [["EARLY-1"], []], ["EARLY-1", "NEVER-PULLED"]);
      const result = await mirror(o, connectionId, source);
      assert.deepEqual(result.openItems?.mismatches, [
        { ref: "NEVER-PULLED", ours: "missing", theirs: "100.0000" },
      ]);
      assert.equal(source.pulls.length, 2, "one late pass found nothing new and the run refused");
      const status = await db.execute<{ status: string }>(
        sql`select status from sync_runs where id = ${result.runId}`,
        "objects",
      );
      assert.equal(status[0]?.status, "failed");
      assert.deepEqual(await mirroredRefs(o), ["EARLY-1"]);
    });
  },
);
