import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  promoteCrmAccount,
  transitionCrmAccountStage,
} from "./crm.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setCrmFeature(orgId: string, enabled: boolean): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ features: { crm: enabled } })}::jsonb where id = ${orgId}`),
  );
}

async function seedParty(orgId: string, name: string): Promise<string> {
  return (
    await withBypassContext(() =>
      db.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, display_name, is_active)
        values (${orgId}, 'company', ${name}, true) returning id`),
    )
  ).rows[0]!.id;
}

async function activeRole(orgId: string, partyId: string): Promise<boolean> {
  const rows = (
    await withBypassContext(() =>
      db.execute(sql`
        select 1 from customer_roles
         where org_id = ${orgId} and party_id = ${partyId} and is_active`),
    )
  ).rows;
  return rows.length > 0;
}

async function profileStage(orgId: string, partyId: string): Promise<string | null> {
  const rows = (
    await withBypassContext(() =>
      db.execute<{ lifecycle_stage: string }>(sql`
        select lifecycle_stage from crm_account_profiles
         where org_id = ${orgId} and party_id = ${partyId}`),
    )
  ).rows;
  return rows[0]?.lifecycle_stage ?? null;
}

test("becoming a customer writes the AR role with the CRM feature off", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await setCrmFeature(org.orgId, false);
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "CRM Off Admin", "admin"));
    const partyId = await seedParty(org.orgId, "Off-Feature Customer");

    const result = await withBypassContext(() =>
      transitionCrmAccountStage(db, {
        orgId: org.orgId,
        partyId,
        actorId,
        toStage: "customer",
        sourceKind: "sales_order",
      }),
    );

    assert.equal(result.customerRoleActive, true);
    assert.equal(result.lifecycleApplied, false);
    assert.equal(await activeRole(org.orgId, partyId), true);
    assert.equal(await profileStage(org.orgId, partyId), null);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("promotion still writes profile, role and stage event with CRM on", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await setCrmFeature(org.orgId, true);
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "CRM On Admin", "admin"));
    const partyId = await seedParty(org.orgId, "On-Feature Customer");

    const result = await withBypassContext(() =>
      promoteCrmAccount(db, {
        orgId: org.orgId,
        partyId,
        actorId,
        toStage: "customer",
        sourceKind: "sales_order",
      }),
    );

    assert.equal(result.customerRoleActive, true);
    assert.equal(result.lifecycleApplied, true);
    assert.equal(result.transitioned, true);
    assert.equal(await activeRole(org.orgId, partyId), true);
    assert.equal(await profileStage(org.orgId, partyId), "customer");
    const events = (
      await withBypassContext(() =>
        db.execute(sql`
          select 1 from crm_account_stage_events e
            join crm_account_profiles p on p.id = e.account_profile_id
           where e.org_id = ${org.orgId} and p.party_id = ${partyId}`),
      )
    ).rows;
    assert.ok(events.length > 0, "promotion writes a stage event");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("reactivating a customer role touches only its own tenant row", { skip: !DB }, async () => {
  // ensureActiveCustomerRole keys on party_id and pins the tenant on the
  // conflict write: a bare org_id there is ambiguous (42702) and every
  // lifecycle transition fails. Deactivating one org's role and
  // transitioning again must reactivate through the conflict branch while
  // the other org's role row is untouched.
  const orgA = await withBypassContext(() => createScratchOrg());
  const orgB = await withBypassContext(() => createScratchOrg());
  try {
    const actorA = await withBypassContext(() => createScratchUser(orgA.orgId, "CRM Admin A", "admin"));
    const actorB = await withBypassContext(() => createScratchUser(orgB.orgId, "CRM Admin B", "admin"));
    const partyA = await seedParty(orgA.orgId, "Tenant A Customer");
    const partyB = await seedParty(orgB.orgId, "Tenant B Customer");
    for (const [org, actor, party] of [
      [orgA, actorA, partyA],
      [orgB, actorB, partyB],
    ] as const) {
      await withBypassContext(() =>
        transitionCrmAccountStage(db, {
          orgId: org.orgId, partyId: party, actorId: actor,
          toStage: "customer", sourceKind: "sales_order",
        }),
      );
    }
    await withBypassContext(() => db.execute(sql`
      update customer_roles set is_active = false
       where org_id = ${orgA.orgId} and party_id = ${partyA}`));
    assert.equal(await activeRole(orgA.orgId, partyA), false);

    await withBypassContext(() =>
      transitionCrmAccountStage(db, {
        orgId: orgA.orgId, partyId: partyA, actorId: actorA,
        toStage: "customer", sourceKind: "sales_order",
      }),
    );

    assert.equal(await activeRole(orgA.orgId, partyA), true);
    assert.equal(await activeRole(orgB.orgId, partyB), true);
    const counts = await withBypassContext(() =>
      db.execute<{ orgId: string; n: number }>(sql`
        select org_id as "orgId", count(*)::int as n from customer_roles
         where (org_id, party_id) in ((${orgA.orgId}, ${partyA}), (${orgB.orgId}, ${partyB}))
         group by org_id`),
    );
    assert.deepEqual(
      counts.rows.sort((a, b) => a.orgId.localeCompare(b.orgId)),
      [
        { orgId: orgA.orgId, n: 1 },
        { orgId: orgB.orgId, n: 1 },
      ].sort((a, b) => a.orgId.localeCompare(b.orgId)),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(orgB.orgId));
    await withBypassContext(() => dropScratchOrg(orgA.orgId));
  }
});
