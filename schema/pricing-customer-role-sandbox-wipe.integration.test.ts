/// <reference types="node" />

/**
 * Behavioral coverage for 0247_customer_role_guard_sandbox_wipe.
 *
 * 0244 added `customer_role_pricing_guard`, which refuses to DELETE an active
 * customer role while the customer holds an active item price schedule. 0245
 * exempted the sibling price-level guard from a sandbox wipe but asserted in a
 * comment that this guard "needs no bypass", on the theory that the generic
 * wipe deletes the schedules first. It does not: no FK references
 * customer_roles, so deletionOrder places it at position 94 and
 * item_price_schedules at position 218, and a wiped sandbox holding one active
 * customer role plus one active item price schedule failed with
 *
 *   Customer <id> has active pricing; deactivate its price-level assignments
 *   and item pricing schedules first
 *
 * on every clone/refresh/reset/delete of that sandbox. This suite keeps the
 * exemption honest on both sides:
 *
 *   1. an ordinary delete (no wipe) still refuses, so the tenant guarantee was
 *      not removed;
 *   2. deactivating the role under the wipe GUC still refuses, because a wipe
 *      is not an edit; and
 *   3. deleting the role under the wipe GUC on a sandbox org succeeds.
 *
 * Like every DB-backed suite it self-skips without OPENBOOKS_DB_URL.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

/** Drizzle wraps driver errors (DrizzleQueryError), hiding the PostgreSQL
 * message in `cause`; match the whole rendered chain so a trigger rejection
 * stays assertable. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type EngineDb = typeof import("../engine/src/platform/db.ts");
type EngineFixtures = typeof import("../engine/src/testing/fixtures.ts");

let harness: {
  db: EngineDb["db"];
  withOrg: EngineDb["withOrg"];
  org: Awaited<ReturnType<EngineFixtures["createScratchOrg"]>>;
} | null = null;

async function ctx() {
  if (!harness) {
    const [{ db, withOrg }, { createScratchOrg }] = await Promise.all([
      import("../engine/src/platform/db.ts"),
      import("../engine/src/testing/fixtures.ts"),
    ]);
    const org = await createScratchOrg();
    harness = { db, withOrg, org };
  }
  return harness;
}

/** An active customer role and one active item price schedule for the same
 * customer: the exact shape whose deletion the guard must allow only under a
 * sandbox wipe. Re-asserted on every entry because the pooled fixture reset
 * drops rows this suite added. */
async function seedPricing(
  h: NonNullable<typeof harness>,
  { sandbox = true }: { sandbox?: boolean } = {},
): Promise<{ roleId: string }> {
  // The wipe helper keys on env_kind = 'sandbox'; the scratch org is disposable.
  await h.db.execute(sql`update orgs set env_kind = ${sandbox ? 'sandbox' : 'production'} where id = ${h.org.orgId}`);
  const role = await h.db.execute<{ id: string }>(sql`
    insert into customer_roles (org_id, party_id, is_active)
    values (${h.org.orgId}, ${h.org.customerId}, true)
    on conflict (party_id) do update set is_active = true
    returning id
  `);
  const roleId = role.rows[0]!.id;
  const existing = await h.db.execute<{ id: string }>(sql`
    select id from item_price_schedules
     where org_id = ${h.org.orgId} and customer_id = ${h.org.customerId} and is_active
     limit 1
  `);
  if (existing.rows.length === 0) {
    await h.db.execute(sql`
      insert into item_price_schedules (org_id, item_id, customer_id, currency, effective_from, is_active)
      values (${h.org.orgId}, ${h.org.items.service}, ${h.org.customerId}, 'USD', ${h.org.date}, true)
    `);
  }
  return { roleId };
}

test("an ordinary customer-role delete still refuses while active pricing exists", { skip: !DB }, async () => {
  const h = await ctx();
  await seedPricing(h);
  await assert.rejects(
    () => h!.withOrg(h!.org.orgId, () => h!.db.execute(sql`
      delete from customer_roles where org_id = ${h!.org.orgId} and party_id = ${h!.org.customerId}
    `)),
    (error: unknown) => {
      assert.match(pgMessage(error), /has active pricing/);
      return true;
    },
  );
});

test("the wipe exemption yields to a sandbox wipe but not to an edit", { skip: !DB }, async () => {
  const h = await ctx();
  await seedPricing(h);

  // A wipe is not an edit: deactivating the role under the wipe GUC still refuses.
  await assert.rejects(
    () => h!.withOrg(h!.org.orgId, async () => {
      await h!.db.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
      await h!.db.execute(sql`
        update customer_roles set is_active = false
         where org_id = ${h!.org.orgId} and party_id = ${h!.org.customerId}
      `);
    }),
    (error: unknown) => {
      assert.match(pgMessage(error), /has active pricing/);
      return true;
    },
  );

  // Under the wipe GUC on a sandbox org the delete succeeds — the defect 0245's
  // comment denied.
  const deleted = await h!.withOrg(h!.org.orgId, async () => {
    await h!.db.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
    return h!.db.execute(sql`
      delete from customer_roles where org_id = ${h!.org.orgId} and party_id = ${h!.org.customerId}
    `);
  });
  assert.equal(deleted.rowCount, 1);
});

test("a production tenant is never wiped by a stray wipe GUC", { skip: !DB }, async () => {
  const h = await ctx();
  await seedPricing(h, { sandbox: false });

  // The exemption is scoped to sandbox orgs: even with the wipe GUC set, an
  // ordinary tenant's active customer role is protected.
  await assert.rejects(
    () => h!.withOrg(h!.org.orgId, async () => {
      await h!.db.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
      await h!.db.execute(sql`
        delete from customer_roles where org_id = ${h!.org.orgId} and party_id = ${h!.org.customerId}
      `);
    }),
    (error: unknown) => {
      assert.match(pgMessage(error), /has active pricing/);
      return true;
    },
  );
});

if (DB) {
  test.after(async () => {
    if (!harness) return;
    const { dropScratchOrg } = await import("../engine/src/testing/fixtures.ts");
    await dropScratchOrg(harness.org.orgId);
    harness = null;
  });
}