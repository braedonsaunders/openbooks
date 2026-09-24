import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
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
