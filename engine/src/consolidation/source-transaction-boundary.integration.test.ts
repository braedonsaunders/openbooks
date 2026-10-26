import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { postEntry } from "../journal/post-entry.ts";
import {
  runAutoElimination,
  runOwnershipConsolidation,
  withOwnershipSourceTransaction,
} from "./consolidation.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "standalone ownership refusal retains attributable failure metadata in its own tenant",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const actor = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId);
      // The missing elimination entity is a real configuration refusal, before any posting.
      await assert.rejects(
        () => runOwnershipConsolidation(org.orgId, org.periodId, actor),
        /no active elimination subsidiary for ownership adjustments/,
      );
      const failures = await withOrgContext(org.orgId, () =>
        db.execute<{
          org_id: string;
          status: string;
          error: string;
          created_by: string;
          finished: boolean;
        }>(
          sql`select org_id,status,error,created_by,finished_at is not null as finished
      from ownership_consolidation_runs where org_id=${org.orgId} and period_id=${org.periodId}`,
          "objects",
        ),
      );
      assert.deepEqual(failures, [
        {
          org_id: org.orgId,
          status: "failed",
          error: "no active elimination subsidiary for ownership adjustments",
          created_by: actor,
          finished: true,
        },
      ]);
      const foreign = await withOrgContext(other.orgId, () =>
        db.execute(
          sql`
      select id from ownership_consolidation_runs where org_id=${org.orgId}`,
          "objects",
        ),
      );
      assert.equal(foreign.length, 0);
      const journals = await withOrgContext(org.orgId, () =>
        db.execute(
          sql`
      select id from journal_entries where org_id=${org.orgId}`,
          "objects",
        ),
      );
      assert.equal(journals.length, 0);
    } finally {
      await dropScratchOrg(other.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

for (const isolationLevel of ["REPEATABLE READ", "SERIALIZABLE"] as const) {
  test(
    `elimination joins its owning ${isolationLevel.toLowerCase()} snapshot and rolls back with it`,
    { skip: !DB },
    async () => {
      const org = await createScratchOrg();
      try {
        const actor = await withBypassContext(async () => {
          const actor = (await seedFlowActors(org.orgId)).adminId;
          assert.equal(
            (
              await db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_elimination,is_active)
          values(${randomUUID()},${org.orgId},${org.subsidiaryId},'Elimination entity','CAD','CA',true,true) returning id`,
                "objects",
              )
            ).length,
            1,
          );
          return actor;
        });
        const abort = new Error("Abort the owning source transaction");
        let entryId: string | undefined;
        await assert.rejects(
          () =>
            withOrgTransaction(
              org.orgId,
              async () => {
                const connection = async () =>
                  (
                    await db.execute<{ pid: number; level: string }>(
                      sql`
          select pg_backend_pid() as pid,current_setting('transaction_isolation') as level`,
                      "objects",
                    )
                  )[0]!;
                const before = await connection();
                assert.equal(before.level, isolationLevel.toLowerCase());
                if (isolationLevel === "SERIALIZABLE") {
                  await withOwnershipSourceTransaction(org.orgId, async (executor) => {
                    const nested = (
                      await executor.execute<{ pid: number }>(
                        sql`select pg_backend_pid() as pid`,
                        "objects",
                      )
                    )[0]!;
                    assert.equal(nested.pid, before.pid);
                  });
                  const ownership = await runOwnershipConsolidation(org.orgId, org.periodId, actor);
                  assert.deepEqual(ownership.entryIds, []);
                  const retained = await db.execute<{ status: string }>(
                    sql`select status from ownership_consolidation_runs
            where org_id=${org.orgId} and id=${ownership.runId}`,
                    "objects",
                  );
                  assert.deepEqual(retained, [{ status: "posted" }]);
                } else {
                  await assert.rejects(
                    () =>
                      withOwnershipSourceTransaction(org.orgId, async () => {
                        assert.fail("ownership must not consume a weaker source snapshot");
                      }),
                    /requires a serializable source snapshot/,
                  );
                }
                const result = await runAutoElimination(org.orgId, org.periodId, actor);
                assert.equal(result.status, "no_elimination_required");
                assert.deepEqual(
                  await connection(),
                  before,
                  "native elimination must retain its caller's executor and isolation",
                );
                const posted = await postEntry(db, {
                  orgId: org.orgId,
                  bookId: org.bookId,
                  subsidiaryId: org.subsidiaryId,
                  periodId: org.periodId,
                  postingDate: org.date,
                  entryNumber: `SOURCE-${randomUUID().slice(0, 8)}`,
                  origin: "manual",
                  actorId: actor,
                  currency: "CAD",
                  lines: [
                    { accountId: org.accounts.bank, amount: "-10" },
                    { accountId: org.accounts.cogs, amount: "10" },
                  ],
                });
                entryId = posted.entryId;
                assert.equal(
                  (
                    await db.execute(
                      sql`select id from journal_entries where org_id=${org.orgId} and id=${entryId}`,
                      "objects",
                    )
                  ).length,
                  1,
                );
                throw abort;
              },
              { isolationLevel },
            ),
          (error) => error === abort,
        );
        assert.ok(entryId);
        await withOrgContext(org.orgId, async () => {
          assert.equal(
            (
              await db.execute(
                sql`select id from journal_entries where org_id=${org.orgId} and id=${entryId}`,
                "objects",
              )
            ).length,
            0,
          );
          assert.equal(
            (
              await db.execute(
                sql`select id from audit_log where org_id=${org.orgId} and row_id=${entryId}`,
                "objects",
              )
            ).length,
            0,
          );
          assert.equal(
            (
              await db.execute(
                sql`select id from ownership_consolidation_runs where org_id=${org.orgId}`,
                "objects",
              )
            ).length,
            0,
          );
        });
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );
}

test(
  "consolidation refuses an existing read-committed snapshot before native work",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId);
      await withOrgTransaction(org.orgId, async () => {
        await assert.rejects(
          () =>
            withOwnershipSourceTransaction(org.orgId, async () =>
              assert.fail("must refuse before work"),
            ),
          /requires a serializable source snapshot/,
        );
        await assert.rejects(
          () => runAutoElimination(org.orgId, org.periodId, actor),
          /requires a repeatable-read source snapshot/,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from ownership_consolidation_runs where org_id=${org.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from journal_entries where org_id=${org.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
