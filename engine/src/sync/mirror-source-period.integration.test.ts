import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type { MigrationSource, NativeChanges, SourceEntity } from "./source.ts";
import type { NativeDocument } from "./native.ts";
import type { SyncOptions, SyncResult } from "./sync-result.ts";
import { SyncVerificationError } from "./sync-verification-state.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/** A source emitting posting invoices in the scratch organization's July period. */
class PeriodSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";

  constructor(
    private readonly o: ScratchOrg,
    private readonly invoices: { ref: string; date: string }[],
  ) {}

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  nativeChanges(): Promise<NativeChanges> {
    return Promise.resolve({
      documents: this.invoices.map(
        ({ ref, date }) =>
          ({
            sourceRef: ref,
            kind: "customer_invoice",
            posting: true,
            lifecycleStatus: "approved",
            partyId: this.o.customerId,
            currency: "CAD",
            fxRate: "1",
            documentDate: date,
            postingDate: date,
            postingPeriodId: this.o.periodId,
            dueDate: date,
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
          }) satisfies NativeDocument,
      ),
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
    return Promise.resolve(this.invoices.map(({ ref }) => ({ ref, unpaid: "100" })));
  }
}

/** One mirror run; a refused transaction fails the run's verification, which carries the result. */
async function mirror(
  o: ScratchOrg,
  connectionId: string,
  invoices: { ref: string; date: string }[],
  options: Partial<SyncOptions> = {},
): Promise<SyncResult> {
  try {
    return await runSync(new PeriodSource(o, invoices), "period-probe", {
      kind: "incremental",
      orgId: o.orgId,
      connectionId,
      since: null,
      loadEntitiesFirst: false as const,
      ...options,
    });
  } catch (error) {
    if (error instanceof SyncVerificationError && error.result.docsFailed > 0) return error.result;
    throw error;
  }
}

async function postedEntries(o: ScratchOrg, ref: string) {
  return db.execute<{ document_date: string; posting_date: string; entry_date: string | null }>(
    sql`
      select d.document_date::text as document_date, d.posting_date::text as posting_date,
             je.posting_date::text as entry_date
        from documents d
        left join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id
       where d.org_id = ${o.orgId} and d.custom->>'qboId' = ${ref}`,
    "objects",
  );
}

test(
  "a mirror posts into a source-closed period only under the controller's append-only authority",
  { skip: !DB, timeout: 240_000 },
  async () => {
    const o = await createScratchOrg();
    try {
      const controllerId = await createScratchUser(o.orgId, "Mirror Controller", "admin");
      const connectionId = randomUUID();
      await db.execute(sql`
        insert into connections
          (id, org_id, source, display_name, status, posted_change_policy,
           posted_change_authorized_by, posted_change_authorized_at)
        values (${connectionId}, ${o.orgId}, 'qbo', 'period-probe', 'active',
                'append_only_automatic', ${controllerId}, now() - interval '1 minute')`);
      // The source closed July after the transaction was entered there.
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by, reason)
        values
          (${o.orgId}, ${o.periodId}, ${o.bookId}, null, 'gl', 'closed', now(), ${controllerId},
           'close.importedPeriodLockReason'),
          (${o.orgId}, ${o.periodId}, ${o.bookId}, null, 'ar', 'closed', now(), ${controllerId},
           'close.importedPeriodLockReason')`);
      const invoice = [{ ref: "LATE-1", date: "2026-07-20" }];

      const unauthorized = await mirror(o, connectionId, invoice);
      assert.equal(unauthorized.docsNew, 0);
      assert.equal(unauthorized.docsFailed, 1);
      assert.match(
        unauthorized.skipped.join("\n"),
        /LATE-1: .*The entity accounting period is closed for this posting module/,
      );
      assert.deepEqual(await postedEntries(o, "LATE-1"), []);

      const authorized = await mirror(o, connectionId, invoice, {
        postedChangeAuthorization: {
          actorId: controllerId,
          authorizedAt: new Date(Date.now() - 60_000),
        },
      });
      assert.equal(authorized.docsFailed, 0, authorized.skipped.join("\n"));
      assert.equal(authorized.docsNew, 1);
      assert.deepEqual(await postedEntries(o, "LATE-1"), [
        { document_date: "2026-07-20", posting_date: "2026-07-20", entry_date: "2026-07-20" },
      ]);
      const locks = await db.execute<{ module: string; state: string; reason: string }>(
        sql`
          select module, state, reason from period_locks
           where org_id = ${o.orgId} and period_id = ${o.periodId} order by module`,
        "objects",
      );
      assert.deepEqual(locks, [
        { module: "ar", state: "closed", reason: "close.importedPeriodLockReason" },
        { module: "gl", state: "closed", reason: "close.importedPeriodLockReason" },
      ]);

      // A lock the organization placed itself is not the source's to waive.
      await db.execute(sql`
        update period_locks set reason = 'Controller-completed month close'
         where org_id = ${o.orgId} and period_id = ${o.periodId} and module = 'ar'`);
      const userLocked = await mirror(o, connectionId, [{ ref: "LATE-2", date: "2026-07-21" }], {
        postedChangeAuthorization: {
          actorId: controllerId,
          authorizedAt: new Date(Date.now() - 60_000),
        },
      });
      assert.equal(userLocked.docsNew, 0);
      assert.equal(userLocked.docsFailed, 1);
      assert.match(userLocked.skipped.join("\n"), /LATE-2: .*AR is closed/);
      assert.deepEqual(await postedEntries(o, "LATE-2"), []);
    } finally {
      await dropScratchOrg(o.orgId);
    }
  },
);
