import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type {
  MigrationSource,
  NativeChanges,
  SourceEntity,
} from "./source.ts";
import type { NativeDocument } from "./native.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/** Minimal fake source emitting a single posting invoice. */
class AuditSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";

  constructor(private readonly o: ScratchOrg) {}

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  nativeChanges(): Promise<NativeChanges> {
    return Promise.resolve({
      documents: [{
        sourceRef: "TST-AUDIT",
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
          description: "audit probe",
          lineNumber: 1,
        }],
      } satisfies NativeDocument],
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
    return Promise.resolve([{ ref: "TST-AUDIT", unpaid: "100" }]);
  }
}

/**
 * A mirror-posted document must carry the same posting evidence as every
 * other posted document: an audit_log post row naming the source system
 * (actor null — no user posts a mirror run) with the before/after snapshots.
 */
test(
  "a mirror-posted document evidences its posting in audit_log",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await createScratchOrg();
    try {
      const connectionId = randomUUID();
      await db.execute(sql`
        insert into connections (id, org_id, source, display_name)
        values (${connectionId}, ${o.orgId}, 'qbo', 'audit-probe')`);
      const result = await runSync(new AuditSource(o), "audit-probe", {
        kind: "full_migration",
        orgId: o.orgId,
        connectionId,
        since: null,
        loadEntitiesFirst: false as const,
      });
      assert.equal(result.docsFailed, 0, JSON.stringify(result.skipped));
      assert.equal(result.docsNew, 1);

      const doc = (
        await db.execute<{ id: string }>(sql`
          select id from documents where org_id = ${o.orgId} and custom->>'qboId' = 'TST-AUDIT'`)
      ).rows[0]!;
      const rows = (
        await db.execute<{
          action: string;
          actor_id: string | null;
          changes: Record<string, unknown>;
        }>(sql`
          select action, actor_id, changes from audit_log
           where org_id = ${o.orgId} and table_name = 'documents' and row_id = ${doc.id}
           order by at, id
        `)
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, "post");
      assert.equal(rows[0]!.actor_id, null);
      const changes = rows[0]!.changes as {
        mode: string;
        source: string;
        before: { document: { status: string } };
        after: { document: { status: string } };
      };
      assert.equal(changes.mode, "record_post");
      assert.equal(changes.source, "qbo");
      assert.equal(changes.before.document.status, "approved");
      assert.equal(changes.after.document.status, "posted");
    } finally {
      await dropScratchOrg(o.orgId);
    }
  },
);
