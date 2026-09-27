import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { balanceOf, createRetainer, draftFeeDrawdown } from "./retainers.ts";
import { ResourcingRefusal } from "./errors.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Fixture = { org: ScratchOrg; actorId: string; projectId: string };
async function withFixture(customerCurrency: string | null, multiCurrency: boolean, work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    const projectId = randomUUID();
    await withBypassContext(async () => {
      // EUR is a shared ISO registry row; an existing row already provides the needed lookup.
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('EUR', 'Euro', 2) on conflict (code) do nothing`);
      const settings = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ projects: true, resourcing: true, retainerBilling: true, multiCurrency })}::jsonb, true)
         where id = ${org.orgId} returning id
      `);
      assert.equal(settings.rows.length, 1);
      const role = await db.execute<{ party_id: string }>(sql`
        insert into customer_roles (org_id, party_id, currency) values (${org.orgId}, ${org.customerId}, ${customerCurrency}) returning party_id
      `);
      assert.equal(role.rows.length, 1);
      const project = await db.execute<{ id: string }>(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${`RC-${projectId.slice(0, 8)}`}, 'Currency test', ${org.customerId}, 'active', true, '{}'::jsonb) returning id
      `);
      assert.equal(project.rows.length, 1);
    });
    await work({ org, actorId, projectId });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

function terms(f: Fixture, currency?: string) {
  return {
    orgId: f.org.orgId, actorId: f.actorId, allowedSubsidiaryIds: new Set([f.org.subsidiaryId]),
    projectId: f.projectId, customerPartyId: f.org.customerId, kind: "fees" as const,
    ...(currency === undefined ? {} : { currency }), totalAmount: "100.00", startsOn: "2026-06-01",
    endsOn: "2026-12-31", retainerItemId: f.org.items.service,
  };
}

test("retainer currency defaults from the customer and then the organization", enabled, async () => {
  await withFixture("EUR", true, async (f) => {
    const customerDefault = await createRetainer(terms(f));
    assert.equal(customerDefault.currency, "EUR");
    assert.deepEqual(balanceOf(customerDefault, []), { amount: customerDefault.totalAmount, currency: "EUR" });
    const activated = await withBypassContext(() => db.execute(sql`update res_retainers set state = 'active' where org_id = ${f.org.orgId} and id = ${customerDefault.id} returning id`));
    assert.equal(activated.rows.length, 1);
    const drawdown = await draftFeeDrawdown({ orgId: f.org.orgId, actorId: f.actorId, allowedSubsidiaryIds: new Set([f.org.subsidiaryId]), retainerId: customerDefault.id, sunday: "2026-06-07", rawAmount: "25.00" });
    assert.equal(drawdown.currency, "EUR");
    const cleared = await withBypassContext(() => db.execute(sql`update customer_roles set currency = '' where org_id = ${f.org.orgId} and party_id = ${f.org.customerId} returning party_id`));
    assert.equal(cleared.rows.length, 1);
    assert.equal((await createRetainer(terms(f))).currency, "CAD");
  });
});

test("an unregistered explicit currency refuses with a registry remedy", enabled, async () => {
  await withFixture(null, true, async (f) => {
    await assert.rejects(createRetainer(terms(f, "ZZZ")), (error: unknown) => {
      assert.ok(error instanceof ResourcingRefusal);
      assert.equal(error.status, 422);
      assert.equal(error.code, "currency_not_enabled");
      assert.equal(error.field, "currency");
      assert.match(error.remedy, /Currencies/);
      return true;
    });
  });
});

test("a foreign retainer currency refuses while Multi-Currency is off", enabled, async () => {
  await withFixture(null, false, async (f) => {
    await assert.rejects(createRetainer(terms(f, "EUR")), (error: unknown) => {
      assert.ok(error instanceof ResourcingRefusal);
      assert.equal(error.status, 422);
      assert.equal(error.code, "multi_currency_disabled");
      assert.equal(error.field, "currency");
      assert.match(error.remedy, /turn on Multi-Currency/);
      return true;
    });
  });
});
