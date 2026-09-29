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

type EntryPoint = [label: string, seed: (orgId: string) => Promise<unknown>];
const FULL_DEFAULT_POINTS: EntryPoint[] = [
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

async function roleSnapshot(orgId: string): Promise<string> {
  const rows = (await db.execute<{ snapshot: string }>(sql`
    select coalesce(jsonb_agg(to_jsonb(role_row) order by role_row.key), '[]'::jsonb)::text as snapshot
      from app_roles role_row where org_id = ${orgId}`)).rows;
  assert.equal(rows.length, 1);
  return rows[0]!.snapshot;
}

test("each entry point gives a new org the current built-in defaults", { skip: !DB }, async () => {
  for (const [label, seed] of FULL_DEFAULT_POINTS) {
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

test("the engine seeder refreshes metadata but preserves customized grants on re-seed", { skip: !DB }, async () => {
  const { orgId } = await createScratchOrg();
  try {
    await seedRolesForOrg(orgId);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, 'steward', 'Steward', false, '["gl.read"]'::jsonb)
      returning id`)).rows;
    assert.equal(inserted.length, 1);
    const customized = (await db.execute<{ id: string }>(sql`
      update app_roles set permissions = '["gl.read"]'::jsonb, description = 'Custom steward note'
       where org_id = ${orgId} and key = 'controller'
      returning id`)).rows;
    assert.equal(customized.length, 1, "customize affected exactly one row");
    const before = await permissionsText(orgId, "controller");

    await seedRolesForOrg(orgId);

    // Byte-identical grants; metadata still refreshes while grants stay.
    assert.equal(await permissionsText(orgId, "controller"), before);
    const kept = await roleByKey(orgId, "controller");
    assert.deepEqual(kept.permissions, ["gl.read"]);
    assert.equal(kept.description, BUILT_IN_ROLES["controller"]!.description);
    const custom = await roleByKey(orgId, "steward");
    assert.equal(custom.is_built_in, false);
    assert.deepEqual(custom.permissions, ["gl.read"]);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});

test("the bootstrap step leaves an existing role catalog byte-identical", { skip: !DB }, async () => {
  const { orgId } = await createScratchOrg();
  try {
    await seedRolesForOrg(orgId);
    await db.execute(sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, 'steward', 'Steward', false, '["gl.read"]'::jsonb)`);
    await db.execute(sql`
      update app_roles set permissions = '["gl.read"]'::jsonb, description = 'Custom steward note'
       where org_id = ${orgId} and key = 'controller'`);
    const before = await roleSnapshot(orgId);

    await seedRoles(orgId);

    assert.equal(await roleSnapshot(orgId), before);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});

test("the bootstrap step preserves a reduced built-in without adding catalog roles", { skip: !DB }, async () => {
  const { orgId } = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into app_roles (org_id, key, name, description, is_built_in, permissions)
      values (${orgId}, 'controller', 'Local controller', 'kept note', true, '["gl.read"]'::jsonb)`);
    const before = await roleSnapshot(orgId);

    await seedRoles(orgId);

    assert.equal(await roleSnapshot(orgId), before);
    assert.equal(await builtInCount(orgId), 1);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});

test("the bootstrap step adds nothing to an org holding only custom roles", { skip: !DB }, async () => {
  const { orgId } = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, 'steward', 'Steward', false, '["gl.read"]'::jsonb)`);
    const before = await roleSnapshot(orgId);

    await seedRoles(orgId);

    assert.equal(await roleSnapshot(orgId), before);
    assert.equal(await builtInCount(orgId), 0);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});

test("the bootstrap step keeps a same-key custom role instead of refusing", { skip: !DB }, async () => {
  const { orgId } = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, 'admin', 'admin', false, '[]'::jsonb)`);
    const before = await roleSnapshot(orgId);

    await seedRoles(orgId);

    assert.equal(await roleSnapshot(orgId), before);
    const kept = await roleByKey(orgId, "admin");
    assert.equal(kept.is_built_in, false);
    assert.equal(kept.name, "admin");
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});

test("the engine seeder refuses a same-key custom role with a usable remedy and rolls back", { skip: !DB }, async () => {
  const { orgId } = await createScratchOrg();
  try {
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, 'controller', 'Local controller', false, '["gl.read"]'::jsonb)
      returning id`)).rows;
    assert.equal(inserted.length, 1);
    await assert.rejects(
      () => seedRolesForOrg(orgId),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /built-in role "controller"/);
        assert.match(message, new RegExp(orgId));
        assert.match(message, /replacement/i);
        assert.match(message, /reassign/i);
        assert.match(message, /same permissions|same scope/i);
        assert.doesNotMatch(message, /rename/i);
        return true;
      },
    );
    assert.equal(await builtInCount(orgId), 0, "catalogue rolled back");
    const kept = await roleByKey(orgId, "controller");
    assert.equal(kept.is_built_in, false);
    assert.equal(kept.name, "Local controller");
    assert.deepEqual(kept.permissions, ["gl.read"]);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});
