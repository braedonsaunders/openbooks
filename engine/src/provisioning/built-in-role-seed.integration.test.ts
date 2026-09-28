import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { BUILT_IN_ROLES } from "../organization/permissions.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { seedRolesForOrg } from "./seed-roles.ts";
import { seedRoles } from "../../../scripts/bootstrap/seed.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Built-in role seeds are new-organization defaults only. The first seed
 * stores the current catalogue permissions; every later seed refreshes only
 * name/description metadata and must leave stored permissions exactly as
 * configured. Each entry point is driven independently through its real
 * export: the engine seeder's per-org entry and the bootstrap role step.
 */

type EntryPoint = [label: string, seed: (orgId: string) => Promise<unknown>];
const ENTRY_POINTS: EntryPoint[] = [
  ["engine seeder", (orgId) => seedRolesForOrg(orgId)],
  ["bootstrap step", (orgId) => seedRoles(orgId)],
];

type RoleRow = {
  key: string;
  name: string;
  description: string | null;
  is_built_in: boolean;
  permissions: unknown;
};

async function roleByKey(orgId: string, key: string): Promise<RoleRow> {
  const rows = (await db.execute<RoleRow>(sql`
    select key, name, description, is_built_in, permissions from app_roles
     where org_id = ${orgId} and key = ${key}`)).rows;
  assert.equal(rows.length, 1, `expected exactly one role ${key}`);
  return rows[0]!;
}

async function permissionsText(orgId: string, key: string): Promise<string> {
  const rows = (await db.execute<{ p: string }>(sql`
    select permissions::text as p from app_roles
     where org_id = ${orgId} and key = ${key}`)).rows;
  assert.equal(rows.length, 1, `expected exactly one role ${key}`);
  return rows[0]!.p;
}

async function builtInCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*) as n from app_roles where org_id = ${orgId} and is_built_in`)).rows;
  return Number(rows[0]!.n);
}

test("each entry point gives a new org the current built-in defaults", { skip: !DB }, async () => {
  for (const [label, seed] of ENTRY_POINTS) {
    const { orgId } = await createScratchOrg();
    try {
      await seed(orgId);
      assert.equal(await builtInCount(orgId), Object.keys(BUILT_IN_ROLES).length, label);
      for (const [key, def] of Object.entries(BUILT_IN_ROLES)) {
        const row = await roleByKey(orgId, key);
        assert.equal(row.is_built_in, true, `${label} ${key}`);
        assert.equal(row.name, def.name, `${label} ${key}`);
        assert.equal(row.description, def.description, `${label} ${key}`);
        assert.deepEqual(row.permissions, def.permissions, `${label} ${key}`);
      }
    } finally {
      await dropScratchOrgReporting(orgId);
    }
  }
});

test("each entry point preserves customized built-in grants on re-seed", { skip: !DB }, async () => {
  for (const [label, seed] of ENTRY_POINTS) {
    const { orgId } = await createScratchOrg();
    try {
      await seed(orgId);
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${orgId}, 'steward', 'Steward', false, '["gl.read"]'::jsonb)
        returning id`)).rows;
      assert.equal(inserted.length, 1, label);
      const customized = (await db.execute<{ id: string }>(sql`
        update app_roles set permissions = '["gl.read"]'::jsonb, description = 'Custom steward note'
         where org_id = ${orgId} and key = 'controller'
        returning id`)).rows;
      assert.equal(customized.length, 1, `${label} customize affected exactly one row`);
      const before = await permissionsText(orgId, "controller");

      await seed(orgId);

      // Byte-identical grants; metadata still refreshes while grants stay.
      assert.equal(await permissionsText(orgId, "controller"), before, label);
      const kept = await roleByKey(orgId, "controller");
      assert.deepEqual(kept.permissions, ["gl.read"], label);
      assert.equal(kept.description, BUILT_IN_ROLES["controller"]!.description, label);
      const custom = await roleByKey(orgId, "steward");
      assert.equal(custom.is_built_in, false, label);
      assert.deepEqual(custom.permissions, ["gl.read"], label);
    } finally {
      await dropScratchOrgReporting(orgId);
    }
  }
});

test("a same-key custom role refuses each entry point and rolls the catalogue back", { skip: !DB }, async () => {
  for (const [label, seed] of ENTRY_POINTS) {
    const { orgId } = await createScratchOrg();
    try {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${orgId}, 'controller', 'Local controller', false, '["gl.read"]'::jsonb)
        returning id`)).rows;
      assert.equal(inserted.length, 1, label);
      // The conflicting update matches zero rows; that anomaly refuses by
      // key, and the single catalogue transaction rolls back the earlier
      // inserts so no partial catalogue commits.
      await assert.rejects(
        () => seed(orgId),
        /built-in role "controller"[\s\S]*Admin -> Users & Roles/,
        label,
      );
      assert.equal(await builtInCount(orgId), 0, `${label} catalogue rolled back`);
      const kept = await roleByKey(orgId, "controller");
      assert.equal(kept.is_built_in, false, label);
      assert.equal(kept.name, "Local controller", label);
      assert.deepEqual(kept.permissions, ["gl.read"], label);
    } finally {
      await dropScratchOrgReporting(orgId);
    }
  }
});
