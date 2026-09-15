import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createManagedProperty,
  PropertyManagementError,
  updateManagedProperty,
} from "./property-management.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

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
        actorId,
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
      actorId,
      subsidiaryId: org.subsidiaryId,
      code: "PROP-DIMENSION",
      name: "Dimension property",
      propertyType: "commercial",
    });
    await assert.rejects(
      updateManagedProperty({
        orgId: org.orgId,
        actorId,
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
