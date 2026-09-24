import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withBypass } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { ScopeNotFoundError, withScopeSnapshot } from "../organization/subsidiary-scope.ts";
import {
  billDueLeaseCharges,
  createManagedProperty,
  createPropertyLease,
  createPropertyUnit,
  propertyManagementWorkspace,
  updateManagedProperty,
} from "./management.ts";

interface PropertyFixture {
  orgId: string;
  actorId: string;
  subA: string;
  subB: string;
  propA: string;
  propB: string;
}

async function seedFixture(): Promise<PropertyFixture> {
  const scratch = await withBypass(() => createScratchOrg());
  await withBypass(() => db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
     where id = ${scratch.orgId}`));
  const subB = randomUUID();
  await withBypass(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${subB}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Second entity', 'CAD', 'CA')
  `));
  const actorId = randomUUID();
  const common = { orgId: scratch.orgId, actorId, allowedSubsidiaryIds: null as ReadonlySet<string> | null };
  const propA = (await withBypass(() => createManagedProperty({
    ...common, subsidiaryId: scratch.subsidiaryId, code: "PROP-A", name: "Entity A house", propertyType: "residential",
    rentIncomeAccountId: scratch.accounts.revenue,
  }))).id;
  const propB = (await withBypass(() => createManagedProperty({
    ...common, subsidiaryId: subB, code: "PROP-B", name: "Entity B house", propertyType: "residential",
    rentIncomeAccountId: scratch.accounts.revenue,
  }))).id;
  // One unit and draft lease on A, one unit on B: the scoped workspace
  // must keep every subordinate with its own entity.
  await withBypass(() => db.execute(sql`
    insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
    values (${scratch.orgId}, ${scratch.customerId}, ${scratch.accounts.ar}, '0', 'CAD', false, ${actorId}, ${actorId})`));
  const unitA = (await withBypass(() => createPropertyUnit({
    ...common, propertyId: propA, code: "A-101",
  }))).id;
  await withBypass(() => createPropertyUnit({ ...common, propertyId: propB, code: "B-101" }));
  await withBypass(() => createPropertyLease({
    ...common, propertyId: propA, unitId: unitA, tenantId: scratch.customerId, leaseNumber: "L-A-1",
    startsOn: "2026-01-01", endsOn: "2026-12-31", baseRent: "1000", billingDay: 1,
    paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none",
    lateFeeType: "none", lateFeeValue: "0", graceDays: 0, autoInvoice: true, autoPost: false,
  }));
  return { orgId: scratch.orgId, actorId, subA: scratch.subsidiaryId, subB, propA, propB };
}

async function assertScopeNotFound(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ScopeNotFoundError, `expected ScopeNotFoundError, got ${error}`);
    assert.equal((error as ScopeNotFoundError).status, 404);
    assert.equal((error as Error).message, "not found");
    return true;
  });
}

test("property workspace shows a restricted caller only their own entity", async () => {
  const fx = await seedFixture();
  try {
    const scopeA = new Set([fx.subA]);
    const aOnly = await withBypass(() => propertyManagementWorkspace(fx.orgId, scopeA));
    assert.deepEqual(aOnly.properties.map((row) => String(row.id)), [fx.propA]);
    assert.equal(aOnly.leases.length, 1);
    assert.equal(String(aOnly.leases[0]!.propertyId), fx.propA);
    assert.equal(String(aOnly.leases[0]!.leaseNumber), "L-A-1");
    assert.deepEqual(aOnly.units.map((row) => String(row.code)), ["A-101"]);
    const scopeB = new Set([fx.subB]);
    const bOnly = await withBypass(() => propertyManagementWorkspace(fx.orgId, scopeB));
    assert.deepEqual(bOnly.properties.map((row) => String(row.id)), [fx.propB]);
    assert.deepEqual(bOnly.leases, []);
    assert.deepEqual(bOnly.units.map((row) => String(row.code)), ["B-101"]);
    const all = await withBypass(() => propertyManagementWorkspace(fx.orgId, null));
    assert.equal(all.properties.length, 2);
    const none = await withBypass(() => propertyManagementWorkspace(fx.orgId, new Set()));
    assert.deepEqual(none.properties, []);
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("property workspace snapshot does not tear across a concurrent rehome", async () => {
  const fx = await seedFixture();
  try {
    const scopeA = new Set([fx.subA]);
    const moveMidSnapshot = async () => {
      const client = await pool.connect();
      try {
        await client.query("select set_config('app.bypass_rls', 'on', true)");
        await client.query("update managed_properties set subsidiary_id = $1 where id = $2 and org_id = $3", [
          fx.subB,
          fx.propA,
          fx.orgId,
        ]);
      } finally {
        client.release();
      }
    };
    const seen = await withBypass(() => withScopeSnapshot(fx.orgId, async () => {
      const first = (await db.execute<{ id: string }>(sql`
        select id from managed_properties where org_id = ${fx.orgId}
          and subsidiary_id = ${fx.subA} order by id`)).rows.map((row) => row.id);
      await moveMidSnapshot();
      const second = (await db.execute<{ id: string }>(sql`
        select id from managed_properties where org_id = ${fx.orgId}
          and subsidiary_id = ${fx.subA} order by id`)).rows.map((row) => row.id);
      return { first, second };
    }));
    assert.deepEqual(seen.first, [fx.propA]);
    assert.deepEqual(seen.second, [fx.propA], "the snapshot must not see the concurrent rehome");
    // The move did commit: a fresh scoped read no longer sees the property.
    const after = await withBypass(() => propertyManagementWorkspace(fx.orgId, scopeA));
    assert.deepEqual(after.properties, []);
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("property writes refuse out-of-scope records with the uniform not-found", async () => {
  const fx = await seedFixture();
  try {
    const scopeA = new Set([fx.subA]);
    const edit = {
      orgId: fx.orgId, actorId: fx.actorId, allowedSubsidiaryIds: scopeA as ReadonlySet<string> | null,
      propertyId: fx.propB, subsidiaryId: fx.subB, code: "PROP-B", name: "Renamed by A",
      propertyType: "residential", status: "active",
    };
    // Two entities: a restricted caller cannot touch the other entity's
    // property even though the id is valid.
    await withBypass(() => assertScopeNotFound(updateManagedProperty(edit)));
    // Rehome race: the property moves out of scope and the locked recheck
    // refuses instead of editing another entity's record.
    await withBypass(() => updateManagedProperty({
      ...edit, propertyId: fx.propA, subsidiaryId: fx.subA, code: "PROP-A", name: "Entity A house",
    }));
    await withBypass(() => db.execute(sql`
      update managed_properties set subsidiary_id = ${fx.subB}
       where id = ${fx.propA} and org_id = ${fx.orgId}`));
    await withBypass(() => assertScopeNotFound(updateManagedProperty({
      ...edit, propertyId: fx.propA, code: "PROP-A", name: "Entity A house",
    })));
    // An unrestricted caller is unaffected by the move.
    await withBypass(() => updateManagedProperty({
      ...edit, propertyId: fx.propA, allowedSubsidiaryIds: null, subsidiaryId: fx.subB,
      code: "PROP-A", name: "Entity A house",
    }));
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("property write waits out a concurrent rehome and then refuses", async () => {
  const fx = await seedFixture();
  try {
    const scopeA = new Set([fx.subA]);
    const client = await pool.connect();
    try {
      // Bypass and lock inside the transaction: a SET LOCAL issued before
      // BEGIN is a no-op, and a pooled connection inherits whatever GUCs
      // the previous checkout left behind — either failure mode silently
      // locks zero rows and the race below stops proving anything.
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const held = await client.query("select id from managed_properties where id = $1 for update", [fx.propA]);
      assert.equal(held.rows.length, 1, "holder must pin the property row for the race");
      // The engine write starts while the lock is held: it must block on
      // the property lock rather than act on a stale subsidiary.
      let settled = false;
      const pending = withBypass(() => updateManagedProperty({
        orgId: fx.orgId, actorId: fx.actorId, allowedSubsidiaryIds: scopeA as ReadonlySet<string> | null,
        propertyId: fx.propA, subsidiaryId: fx.subA, code: "PROP-A", name: "Raced rename",
        propertyType: "residential", status: "active",
      })).then(
        (value) => { settled = true; return value; },
        (reason: unknown) => { settled = true; throw reason; },
      );
      // Rehome behind the waiter and release it: the locked recheck must
      // observe the move and refuse.
      await client.query("update managed_properties set subsidiary_id = $1 where id = $2", [fx.subB, fx.propA]);
      await client.query("commit");
      await assertScopeNotFound(pending);
      assert.equal(settled, true);
      const name = (await withBypass(() => db.execute<{ name: string }>(sql`
        select name from managed_properties where id = ${fx.propA} and org_id = ${fx.orgId}`))).rows[0]!.name;
      assert.equal(name, "Entity A house", "the refused write changed nothing");
    } finally {
      // Roll back before releasing: a pooled connection never rolls back on
      // its own, and an abandoned row lock here would block later writers.
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});

test("portfolio-wide property billing requires the unrestricted sentinel", async () => {
  const fx = await seedFixture();
  try {
    await assert.rejects(
      withBypass(() => billDueLeaseCharges(fx.orgId, fx.actorId, new Set([fx.subA]))),
      (error: unknown) =>
        error instanceof Error && /unrestricted subsidiary access/.test(error.message),
    );
  } finally {
    await withBypass(() => dropScratchOrg(fx.orgId));
  }
});
