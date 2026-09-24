import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, withBypass } from "../platform/db.ts";
import {
  createManagedProperty,
  PropertyManagementError,
  updateManagedProperty,
} from "./management.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

async function seedBranchLocation(orgId: string, parentId: string): Promise<string> {
  const branchId = randomUUID();
  const locationId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
    values (${branchId}, ${orgId}, ${parentId}, 'Property dimension branch', 'CAD', 'CA')
  `);
  await db.execute(sql`
    insert into locations(id, org_id, name, is_active, subsidiary_id, subsidiary_include_children)
    values (${locationId}, ${orgId}, 'Property branch location', true, ${branchId}, false)
  `);
  return locationId;
}

async function seedInactiveSubsidiary(orgId: string, parentId: string): Promise<string> {
  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries(id, org_id, parent_id, name, base_currency, country, is_active)
    values (${subsidiaryId}, ${orgId}, ${parentId}, 'Inactive property subsidiary', 'CAD', 'CA', false)
  `);
  return subsidiaryId;
}

async function enablePropertyManagement(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
         coalesce(settings->'features', '{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
     where id = ${orgId}
  `);
}

test("property creation rejects a location owned by another subsidiary", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enablePropertyManagement(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const locationId = await seedBranchLocation(org.orgId, org.subsidiaryId);
    await assert.rejects(
      createManagedProperty({
        orgId: org.orgId,
        actorId, allowedSubsidiaryIds: null,
        subsidiaryId: org.subsidiaryId,
        locationId,
        code: "PROP-CROSS-SUB",
        name: "Cross-subsidiary property",
        propertyType: "commercial",
      }),
      (error: unknown) => error instanceof PropertyManagementError && /dimensions do not belong/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("property creation waits for a concurrent feature disable and then refuses", { skip: !process.env.OPENBOOKS_DB_URL, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  const holder = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  let pending: Promise<{ id: string }> | undefined;
  try {
    await enablePropertyManagement(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await holder.connect();
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls','on',true)");
    await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`openbooks:feature-gate:${org.orgId}`]);
    const staged = await holder.query(
      "update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{\"propertyManagement\":false}'::jsonb) where id=$1",
      [org.orgId],
    );
    assert.equal(staged.rowCount, 1, 'the concurrent writer must stage the feature disable');
    const holderPid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;

    const request = withBypass(() => createManagedProperty({
      orgId: org.orgId,
      actorId,
      allowedSubsidiaryIds: null,
      subsidiaryId: org.subsidiaryId,
      code: 'PROPERTY-GATE-RACE',
      name: 'Property gate race',
      propertyType: 'commercial',
    }));
    pending = request;
    void request.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await holder.query('select pg_stat_clear_snapshot()');
      const check = await holder.query<{ blocked: boolean }>(
        'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',
        [holderPid],
      );
      if (check.rows[0]?.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(blocked, 'property write must wait on the shared feature-gate lock');
    await holder.query('commit');
    await assert.rejects(request, (error: unknown) =>
      error instanceof PropertyManagementError && /feature is disabled/.test(error.message),
    );
    const row = await db.execute(sql`select id from managed_properties where org_id=${org.orgId} and code='PROPERTY-GATE-RACE'`);
    assert.equal(row.rows.length, 0);
  } finally {
    await holder.query('rollback').catch(() => {});
    await pending?.catch(() => {});
    await holder.end();
    await dropScratchOrg(org.orgId);
  }
});

test("property updates reject moving a location across subsidiaries", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enablePropertyManagement(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const locationId = await seedBranchLocation(org.orgId, org.subsidiaryId);
    const property = await createManagedProperty({
      orgId: org.orgId,
      actorId, allowedSubsidiaryIds: null,
      subsidiaryId: org.subsidiaryId,
      code: "PROP-DIMENSION",
      name: "Dimension property",
      propertyType: "commercial",
    });
    await assert.rejects(
      updateManagedProperty({
        orgId: org.orgId,
        actorId, allowedSubsidiaryIds: null,
        propertyId: property.id,
        subsidiaryId: org.subsidiaryId,
        locationId,
        code: "PROP-DIMENSION",
        name: "Dimension property",
        propertyType: "commercial",
        status: "active",
      }),
      (error: unknown) => error instanceof PropertyManagementError && /dimensions do not belong/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("property creation rejects an inactive subsidiary", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enablePropertyManagement(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const subsidiaryId = await seedInactiveSubsidiary(org.orgId, org.subsidiaryId);
    await assert.rejects(
      createManagedProperty({
        orgId: org.orgId,
        actorId, allowedSubsidiaryIds: null,
        subsidiaryId,
        code: "PROP-INACTIVE-SUB",
        name: "Inactive subsidiary property",
        propertyType: "commercial",
      }),
      (error: unknown) => error instanceof PropertyManagementError && /inactive/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("property updates reject assigning an inactive subsidiary", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enablePropertyManagement(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const subsidiaryId = await seedInactiveSubsidiary(org.orgId, org.subsidiaryId);
    const property = await createManagedProperty({
      orgId: org.orgId,
      actorId, allowedSubsidiaryIds: null,
      subsidiaryId: org.subsidiaryId,
      code: "PROP-INACTIVE-UPDATE",
      name: "Inactive update property",
      propertyType: "commercial",
    });
    await assert.rejects(
      updateManagedProperty({
        orgId: org.orgId,
        actorId, allowedSubsidiaryIds: null,
        propertyId: property.id,
        subsidiaryId,
        code: "PROP-INACTIVE-UPDATE",
        name: "Inactive update property",
        propertyType: "commercial",
        status: "active",
      }),
      (error: unknown) => error instanceof PropertyManagementError && /inactive/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("property creation rejects a control account restricted to another subsidiary", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enablePropertyManagement(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const branchId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
      values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Control account branch', 'CAD', 'CA')
    `);
    await db.execute(sql`
      update accounts
         set subsidiary_id = ${branchId}, subsidiary_include_children = false
       where org_id = ${org.orgId} and id = ${org.accounts.revenue}
    `);
    await assert.rejects(
      createManagedProperty({
        orgId: org.orgId,
        actorId, allowedSubsidiaryIds: null,
        subsidiaryId: org.subsidiaryId,
        rentIncomeAccountId: org.accounts.revenue,
        code: "PROP-CROSS-ACCOUNT",
        name: "Cross-subsidiary account property",
        propertyType: "commercial",
      }),
      (error: unknown) => error instanceof PropertyManagementError && /restricted to another subsidiary/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("property updates reject a control account after its subsidiary restriction changes", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enablePropertyManagement(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const property = await createManagedProperty({
      orgId: org.orgId,
      actorId, allowedSubsidiaryIds: null,
      subsidiaryId: org.subsidiaryId,
      rentIncomeAccountId: org.accounts.revenue,
      code: "PROP-ACCOUNT-UPDATE",
      name: "Account update property",
      propertyType: "commercial",
    });
    const branchId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
      values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Updated account branch', 'CAD', 'CA')
    `);
    await db.execute(sql`
      update accounts
         set subsidiary_id = ${branchId}, subsidiary_include_children = false
       where org_id = ${org.orgId} and id = ${org.accounts.revenue}
    `);
    await assert.rejects(
      updateManagedProperty({
        orgId: org.orgId,
        actorId, allowedSubsidiaryIds: null,
        propertyId: property.id,
        subsidiaryId: org.subsidiaryId,
        rentIncomeAccountId: org.accounts.revenue,
        code: "PROP-ACCOUNT-UPDATE",
        name: "Account update property",
        propertyType: "commercial",
        status: "active",
      }),
      (error: unknown) => error instanceof PropertyManagementError && /restricted to another subsidiary/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
