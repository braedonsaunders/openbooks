import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import { resolveAccountGroups } from "../../../engine/src/records/account-groups.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const backfillSql = readFileSync(
  new URL("./0306_account_group_default_backfill.sql", import.meta.url),
  "utf8",
);
const migrationSql = readFileSync(
  new URL("./0319_account_group_single_active_catch_all.sql", import.meta.url),
  "utf8",
);

type StoredGroup = {
  dimension: string;
  key: string;
  name: string;
  sort_order: number;
  is_catch_all: boolean;
  is_active: boolean;
};

async function storedGroups(orgId: string): Promise<StoredGroup[]> {
  return (
    await db.execute<StoredGroup>(sql`
      select dimension, key, name, sort_order, is_catch_all, is_active
        from account_groups
       where org_id = ${orgId} and dimension in ('cost_pool', 'burden')
       order by dimension, sort_order
    `)
  ).rows;
}

function activeCatchAlls(rows: StoredGroup[], dimension: string): StoredGroup[] {
  return rows.filter((row) => row.dimension === dimension && row.is_catch_all && row.is_active);
}

async function unmatchedBucket(orgId: string, dimension: string): Promise<string> {
  const acctRows = (
    await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary)
      values (${orgId}, '9999', 'Zebra reserve', 'expense', false)
      returning id
    `)
  ).rows;
  const resolved = await resolveAccountGroups(dimension, orgId);
  const ref = resolved.byAccount.get(acctRows[0]!.id);
  assert.ok(ref, "the unmatched account must resolve to some group");
  return ref.key;
}

test(
  "0319 keeps the tenant catch-all authoritative, refuses ambiguity by name, and holds one active catch-all",
  { skip: !DB },
  async () => {
    // The 0319 guard makes the ambiguous state unreachable, so remove it
    // to simulate the pre-0319 database this migration is written for. A
    // no-op when the guard was never installed.
    await withBypass(async () => {
      await db.execute(sql`DROP TRIGGER IF EXISTS account_group_catch_all_guard ON public.account_groups`);
      await db.execute(sql`DROP INDEX IF EXISTS public.account_groups_one_active_catch_all`);
    });

    const ambiguous = await withBypass(() => createScratchOrg());
    const custom = await withBypass(() => createScratchOrg());
    const pristine = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        // An operator-customized `other` (re-sorted, so not the pristine
        // backfill literal) beside their own custom-key catch-all: two
        // tenant-authored policies no migration may choose between.
        await db.execute(sql`
          insert into account_groups (org_id, dimension, key, name, color, sort_order, match, is_catch_all, is_active)
          values (${ambiguous.orgId}, 'cost_pool', 'other', 'Other', '#94a3b8', 95,
                  '{}'::jsonb, true, true),
                 (${ambiguous.orgId}, 'cost_pool', 'misc', 'Miscellaneous', '#000000', 100,
                  '{}'::jsonb, true, true)
        `);
        // A pre-existing custom-key catch-all sorting AFTER the default.
        await db.execute(sql`
          insert into account_groups (org_id, dimension, key, name, color, sort_order, match, is_catch_all, is_active)
          values (${custom.orgId}, 'cost_pool', 'misc', 'Miscellaneous', '#000000', 100,
                  '{}'::jsonb, true, true)
        `);
        await db.execute(sql.raw(backfillSql));
      });

      // The backfill created the second catch-all on the custom tenant.
      assert.deepEqual(
        activeCatchAlls(await withBypass(() => storedGroups(custom.orgId)), "cost_pool").map((row) => row.key),
        ["other", "misc"],
        "0306 inserts `other` beside the pre-existing custom catch-all (the U3 defect)",
      );

      // Ambiguity aborts naming the org: the operator decides, never the migration.
      // (Drizzle embeds the SQL text in the outer message; the raised
      // refusal travels on the driver's cause chain.)
      const refusalText = (error: unknown): string => {
        const messages: string[] = [];
        let current: unknown = error;
        while (current && typeof current === "object" && messages.length < 6) {
          const candidate = current as { message?: unknown; cause?: unknown };
          if (typeof candidate.message === "string") messages.push(candidate.message);
          current = candidate.cause;
        }
        return messages.join("\n");
      };
      // The refusal aborts its own transaction, so it runs isolated from
      // the reads that follow.
      await withBypass(async () => {
        await assert.rejects(
          db.execute(sql.raw(migrationSql)),
          (error: unknown) => {
            const message = refusalText(error);
            assert.match(message, new RegExp(ambiguous.orgId), "the refusal names the org");
            assert.match(message, /cost_pool/, "the refusal names the dimension");
            assert.match(message, /deactivate all but the authoritative group/, "the refusal names the remedy");
            return true;
          },
          "ambiguous duplicate catch-alls must refuse, not guess",
        );
      });
      // The aborted run changed nothing: both groups stay active, and
      // the repair the same run attempted on the custom tenant rolls
      // back with it — a refused migration is never half-applied.
      assert.equal(
        activeCatchAlls(await withBypass(() => storedGroups(ambiguous.orgId)), "cost_pool").length,
        2,
        "a refused migration leaves operator policy untouched",
      );
      assert.equal(
        activeCatchAlls(await withBypass(() => storedGroups(custom.orgId)), "cost_pool").length,
        2,
        "the refused run rolls back its own repair as well",
      );

      // The operator keeps their custom catch-all and deactivates `other`;
      // the migration then applies.
      await withBypass(async () => {
        await db.execute(sql`
          update account_groups set is_active = false, updated_at = now()
           where org_id = ${ambiguous.orgId} and dimension = 'cost_pool' and key = 'other'
        `);
        await db.execute(sql.raw(migrationSql));
      });

      // The unambiguous backfill duplicate is repaired by the same run:
      // the pristine default is deactivated (row and history kept), the
      // tenant's catch-all stays authoritative and keeps its bucket.
      const customRows = await withBypass(() => storedGroups(custom.orgId));
      assert.deepEqual(
        activeCatchAlls(customRows, "cost_pool").map((row) => row.key),
        ["misc"],
        "the tenant catch-all stays the only active one",
      );
      const deactivated = customRows.find((row) => row.key === "other")!;
      assert.equal(deactivated.is_active, false, "the backfill-inserted duplicate is deactivated, not deleted");
      assert.equal(
        await withBypass(() => unmatchedBucket(custom.orgId, "cost_pool")),
        "misc",
        "a previously unmatched account still resolves to the tenant catch-all",
      );

      // A re-run of the backfill cannot resurrect the duplicate.
      await withBypass(async () => {
        await db.execute(sql.raw(backfillSql));
      });
      const rerunRows = await withBypass(() => storedGroups(custom.orgId));
      assert.equal(
        rerunRows.find((row) => row.key === "other")!.is_active,
        false,
        "0306 never reactivates a deactivated group",
      );
      assert.deepEqual(
        activeCatchAlls(rerunRows, "cost_pool").map((row) => row.key),
        ["misc"],
      );

      // A tenant with no groups still gets the full defaults, resolving to `other`.
      const pristineRows = await withBypass(() => storedGroups(pristine.orgId));
      assert.deepEqual(
        activeCatchAlls(pristineRows, "cost_pool").map((row) => row.key),
        ["other"],
      );
      assert.equal(
        await withBypass(() => unmatchedBucket(pristine.orgId, "cost_pool")),
        "other",
      );

      // The guard holds for every writer: a second active catch-all is
      // refused with the remedy, while an inactive one keeps its history.
      // The refusal aborts its own transaction, so it runs isolated.
      await withBypass(async () => {
        await assert.rejects(
          db.execute(sql`
            insert into account_groups (org_id, dimension, key, name, sort_order, match, is_catch_all, is_active)
            values (${pristine.orgId}, 'cost_pool', 'sneaky', 'Sneaky', 100, '{}'::jsonb, true, true)
          `),
          (error: unknown) => {
            assert.match(refusalText(error), /only one active catch-all/);
            assert.match(refusalText(error), /deactivate that group first/);
            return true;
          },
          "a second active catch-all names the remedy instead of landing",
        );
      });
      await withBypass(async () => {
        await db.execute(sql`
          insert into account_groups (org_id, dimension, key, name, sort_order, match, is_catch_all, is_active)
          values (${pristine.orgId}, 'cost_pool', 'retired', 'Retired', 100, '{}'::jsonb, true, false)
        `);
      });
      assert.deepEqual(
        activeCatchAlls(await withBypass(() => storedGroups(pristine.orgId)), "cost_pool").map((row) => row.key),
        ["other"],
        "an inactive duplicate keeps history without stealing the bucket",
      );

      // Re-running the migration changes nothing.
      const before = await withBypass(() => storedGroups(pristine.orgId));
      await withBypass(async () => {
        await db.execute(sql.raw(migrationSql));
      });
      assert.deepEqual(await withBypass(() => storedGroups(pristine.orgId)), before);
    } finally {
      await withBypass(() => dropScratchOrg(ambiguous.orgId));
      await withBypass(() => dropScratchOrg(custom.orgId));
      await withBypass(() => dropScratchOrg(pristine.orgId));
    }
  },
);
