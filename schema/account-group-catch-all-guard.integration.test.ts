/**
 * One authoritative catch-all per organization and dimension. Unmatched
 * accounts resolve to the active catch-all, so storage refuses a second
 * active one for every writer, API or direct SQL, and names the remedy.
 * An inactive catch-all keeps its history without stealing the bucket.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/platform/db";
import { resolveAccountGroups } from "@openbooks/engine/records/account-groups";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";

const DB = !!process.env.OPENBOOKS_DB_URL;

function refusalText(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current && typeof current === "object" && messages.length < 6) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string") messages.push(candidate.message);
    current = candidate.cause;
  }
  return messages.join("\n");
}

async function insertGroup(orgId: string, key: string, active: boolean): Promise<void> {
  await db.execute(sql`
    insert into account_groups (org_id, dimension, key, name, sort_order, match, is_catch_all, is_active)
    values (${orgId}, 'cost_pool', ${key}, ${key}, 100, '{}'::jsonb, true, ${active})`);
}

async function activeCatchAlls(orgId: string): Promise<string[]> {
  const rows = await db.execute<{ key: string }>(
    sql`
    select key from account_groups
     where org_id = ${orgId} and dimension = 'cost_pool' and is_catch_all and is_active
     order by key`,
    "objects",
  );
  return rows.map((row) => row.key);
}

async function unmatchedBucket(orgId: string): Promise<string> {
  const [account] = await db.execute<{ id: string }>(
    sql`
    insert into accounts (org_id, number, name, type, is_summary)
    values (${orgId}, '9999', 'Zebra reserve', 'expense', false)
    returning id`,
    "objects",
  );
  const resolved = await resolveAccountGroups("cost_pool", orgId);
  const ref = resolved.byAccount.get(account!.id);
  assert.ok(ref, "the unmatched account must resolve to some group");
  return ref.key;
}

function isCatchAllRefusal(error: unknown): boolean {
  assert.match(refusalText(error), /only one active catch-all/);
  assert.match(refusalText(error), /deactivate that group first/);
  return true;
}

test(
  "storage holds one active catch-all per dimension and names the remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withBypass(() => insertGroup(org.orgId, "misc", true));

      // Each refusal aborts its own statement, so it runs isolated.
      await withBypass(async () => {
        await assert.rejects(
          insertGroup(org.orgId, "sneaky", true),
          isCatchAllRefusal,
          "a second active catch-all is refused instead of landing",
        );
      });

      await withBypass(() => insertGroup(org.orgId, "retired", false));
      await withBypass(async () => {
        await assert.rejects(
          db.execute(sql`
          update account_groups set is_active = true
           where org_id = ${org.orgId} and dimension = 'cost_pool' and key = 'retired'`),
          isCatchAllRefusal,
          "reactivating a second catch-all is refused the same way",
        );
      });

      assert.deepEqual(await withBypass(() => activeCatchAlls(org.orgId)), ["misc"]);
      assert.equal(
        await withBypass(() => unmatchedBucket(org.orgId)),
        "misc",
        "an inactive duplicate keeps history without stealing the bucket",
      );

      // Deactivating the authoritative group first lets another take over.
      await withBypass(async () => {
        await db.execute(sql`
        update account_groups set is_active = false
         where org_id = ${org.orgId} and dimension = 'cost_pool' and key = 'misc'`);
        await db.execute(sql`
        update account_groups set is_active = true
         where org_id = ${org.orgId} and dimension = 'cost_pool' and key = 'retired'`);
      });
      assert.deepEqual(await withBypass(() => activeCatchAlls(org.orgId)), ["retired"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
