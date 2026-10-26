import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { CustomFieldViewer } from "@openbooks/customization";
import type { ApiField, ResolvedApiType } from "./registry-data.ts";

// A custom field restricted by allowedRoles must not reach a role outside its
// audience: the item read omits its value, and a write by that role neither
// overwrites nor clears the stored value. The item loader and the entity writer
// are exercised directly, since both are the enforcement points the API routes
// share.
const { createRecord, updateRecord } = await import("./writers.ts");
const { loadItem } = await import("../../app/api/items/_lib.ts");
const { MASTER_BY_KEY, masterResource } = await import("../data-io/master-data-resources.ts");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");

const DB = !!process.env.OPENBOOKS_DB_URL;
const FIELD = "cost_basis";
const STORED = "internal basis";

const resolved: ResolvedApiType = {
  key: "items",
  table: "items",
  searchColumn: "name",
  readPermission: "items.read",
  writePermission: "items.manage",
  operations: ["list", "get", "create", "update", "delete"],
  writer: { kind: "entity", table: "items" },
  dynamic: false,
  documentKinds: null,
};

const fields: ApiField[] = [
  {
    name: "kind",
    type: "string",
    required: true,
    writable: true,
    description: null,
    custom: false,
  },
  {
    name: "name",
    type: "string",
    required: true,
    writable: true,
    description: null,
    custom: false,
  },
  {
    name: `cf_${FIELD}`,
    type: "string",
    required: false,
    writable: true,
    description: null,
    custom: true,
  },
];

const CLERK: CustomFieldViewer = { roleKeys: ["clerk"], canManageCustomFields: false };
const MANAGER: CustomFieldViewer = { roleKeys: ["clerk"], canManageCustomFields: true };

function clerkUser(orgId: string, userId: string) {
  return {
    id: userId,
    email: "clerk@custom-field-visibility.scratch.test",
    name: "Clerk",
    roles: [{ key: "clerk", name: "Clerk" }],
    orgId,
    envKind: "production" as const,
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: userId,
    homeOrgId: orgId,
  };
}

async function seed(orgId: string) {
  const userId = randomUUID();
  const roleId = randomUUID();
  const itemId = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into custom_field_defs
        (org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active)
      values
        (${orgId}, 'items', null, ${FIELD}, 'Cost basis', 'text', '{"allowedRoles":["buyer"]}'::jsonb, false, true)`);
    await db.execute(sql`
      insert into app_roles (id, org_id, key, name, permissions)
      values (${roleId}, ${orgId}, 'clerk', 'Clerk', '["items.read","items.manage"]'::jsonb)`);
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash)
      values (${userId}, ${orgId}, 'clerk@custom-field-visibility.scratch.test', 'Clerk', 'x')`);
    await db.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${orgId}, ${userId}, ${roleId})`);
    await db.execute(sql`
      insert into items (id, org_id, code, kind, name, created_by, updated_by, custom)
      values (${itemId}, ${orgId}, 'CF-ITEM', 'service', 'Restricted probe', ${userId}, ${userId},
              ${JSON.stringify({ [FIELD]: STORED })}::jsonb)`);
  });
  return { userId, itemId };
}

async function storedCustom(orgId: string, itemId: string): Promise<Record<string, unknown>> {
  const row = await withBypass(() =>
    db.execute<{ custom: Record<string, unknown> }>(
      sql`
    select custom from items where id = ${itemId} and org_id = ${orgId}`,
      "objects",
    ),
  );
  return row[0]!.custom;
}

test(
  "a restricted item custom value is absent from a non-allowed role's read and survives its update",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const { userId, itemId } = await seed(org.orgId);
      const clerk = clerkUser(org.orgId, userId);

      const hidden = await withOrgContext(org.orgId, () =>
        loadItem(itemId, org.orgId, { customFieldViewer: CLERK }),
      );
      assert.ok(hidden);
      assert.equal(FIELD in (hidden.item.custom as Record<string, unknown>), false);

      const visible = await withOrgContext(org.orgId, () =>
        loadItem(itemId, org.orgId, { customFieldViewer: MANAGER }),
      );
      assert.equal((visible!.item.custom as Record<string, unknown>)[FIELD], STORED);

      const renamed = await withOrgContext(org.orgId, () =>
        updateRecord(
          clerk,
          resolved,
          fields,
          itemId,
          { name: "Restricted probe renamed" },
          { customFieldViewer: CLERK },
        ),
      );
      assert.equal(renamed.status, 200);
      assert.equal(FIELD in (renamed.body as { custom: Record<string, unknown> }).custom, false);
      assert.equal((await storedCustom(org.orgId, itemId))[FIELD], STORED);

      const echoed = await withOrgContext(org.orgId, () =>
        updateRecord(
          clerk,
          resolved,
          fields,
          itemId,
          { [`cf_${FIELD}`]: STORED },
          { customFieldViewer: CLERK },
        ),
      );
      assert.equal(echoed.status, 200, "an unchanged echo of the hidden value is accepted");
      assert.equal((await storedCustom(org.orgId, itemId))[FIELD], STORED);

      const overwritten = await withOrgContext(org.orgId, () =>
        updateRecord(
          clerk,
          resolved,
          fields,
          itemId,
          { [`cf_${FIELD}`]: "changed" },
          { customFieldViewer: CLERK },
        ),
      );
      assert.equal(overwritten.status, 403);
      assert.match(
        String((overwritten.body as { error: string }).error),
        /restricted to other roles/,
      );
      assert.equal((await storedCustom(org.orgId, itemId))[FIELD], STORED);

      const cleared = await withOrgContext(org.orgId, () =>
        updateRecord(
          clerk,
          resolved,
          fields,
          itemId,
          { [`cf_${FIELD}`]: null },
          { customFieldViewer: CLERK },
        ),
      );
      assert.equal(cleared.status, 403);
      assert.equal((await storedCustom(org.orgId, itemId))[FIELD], STORED);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "master-data export hides restricted custom columns and import refuses their values",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const { userId, itemId } = await seed(org.orgId);
      const itemEntity = MASTER_BY_KEY.get("items");
      assert.ok(itemEntity);
      const resource = masterResource(itemEntity, org.orgId, CLERK);
      const read = await withOrgContext(org.orgId, () =>
        resource.read({ allowedSubsidiaryIds: null, customFieldViewer: CLERK }),
      );
      assert.equal(
        read.fields.some((field) => field.key === FIELD),
        false,
      );
      assert.equal(
        read.columns.some((column) => column.key === FIELD),
        false,
      );
      assert.equal(read.rows[0]![FIELD], undefined);

      const outcome = await withOrgContext(org.orgId, () =>
        resource.write(
          [{ code: "CF-ITEM", name: "Restricted probe", kind: "service", [FIELD]: "overwritten" }],
          "upsert",
          { orgId: org.orgId, actorId: userId, dryRun: false, customFieldViewer: CLERK },
        ),
      );
      assert.deepEqual(outcome, {
        created: 0,
        updated: 0,
        failed: 1,
        errors: [
          {
            row: 1,
            message: "Cost basis is restricted to other roles and cannot be changed by your role",
          },
        ],
      });
      assert.equal((await storedCustom(org.orgId, itemId))[FIELD], STORED);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a create by a non-allowed role that sets a restricted item custom value is refused and writes nothing",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const { userId } = await seed(org.orgId);
      const clerk = clerkUser(org.orgId, userId);
      const name = `Refused item ${randomUUID()}`;

      const created = await withOrgContext(org.orgId, () =>
        createRecord(
          clerk,
          resolved,
          fields,
          { kind: "service", name, [`cf_${FIELD}`]: "x" },
          { customFieldViewer: CLERK },
        ),
      );
      assert.equal(created.status, 403);

      const rows = await withBypass(() =>
        db.execute<{ id: string }>(
          sql`
        select id from items where org_id = ${org.orgId} and name = ${name}`,
          "objects",
        ),
      );
      assert.equal(rows.length, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
