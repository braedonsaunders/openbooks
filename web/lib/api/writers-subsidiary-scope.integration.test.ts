import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The writer imports server-only services. Shim the marker package so this
// focused integration suite can load the production module under node:test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { deleteRecord, updateRecord } = await import("./writers.ts");
const { loadApiSchema, resolveApiType } = await import("./schema-registry.ts");
const { db, env, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } =
  await import("@openbooks/engine/src/testing/fixtures.ts");

// Subsidiary scope gates only types carrying a subsidiary_id field (the
// platform list/get paths check `fields.some(f => f.name === 'subsidiary_id')`
// before filtering). The items catalog has no subsidiary dimension, so a
// subsidiary-restricted caller must be able to update and delete items —
// failing closed here while create stays open would strand catalog rows that
// the same caller is allowed to create.
test(
  "a subsidiary-restricted caller can update and delete dimension-less items",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const subsidiaryId = randomUUID();
      const roleId = randomUUID();
      const userId = randomUUID();
      const itemId = randomUUID();
      await withBypass(async () => {
        await db.execute(sql`
          insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
          values (${subsidiaryId}, ${org.orgId},
                  (select id from subsidiaries where org_id = ${org.orgId} and parent_id is null limit 1),
                  'Scope A', 'USD', 'US')`);
        await db.execute(sql`
          insert into app_roles (id, org_id, key, name, permissions, subsidiary_restriction)
          values (${roleId}, ${org.orgId}, 'scope-a-clerk', 'Scope A Clerk',
                  '["items.manage"]'::jsonb,
                  ${JSON.stringify({ mode: "list", subsidiaryIds: [subsidiaryId] })}::jsonb)`);
        await db.execute(sql`
          insert into users (id, org_id, email, name, password_hash)
          values (${userId}, ${org.orgId}, 'scope-a-clerk@scratch.test', 'Scope A Clerk', 'x')`);
        await db.execute(sql`
          insert into role_assignments (org_id, user_id, role_id)
          values (${org.orgId}, ${userId}, ${roleId})`);
        await db.execute(sql`
          insert into items (id, org_id, kind, name, created_by, updated_by)
          values (${itemId}, ${org.orgId}, 'service', 'Scope Probe Item', ${userId}, ${userId})`);
      });

      const user = {
        id: userId,
        email: "scope-a-clerk@scratch.test",
        name: "Scope A Clerk",
        roles: [{ key: "scope-a-clerk", name: "Scope A Clerk" }],
        orgId: org.orgId,
        envKind: "production" as const,
        productionOrgId: org.orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: org.orgId,
      };
      const resolved = await withOrgContext(org.orgId, () =>
        resolveApiType(org.orgId, "items"),
      );
      assert.ok(resolved, "items type resolves");
      const schema = (
        await withOrgContext(org.orgId, () => loadApiSchema(org.orgId))
      ).find((s) => s.key === "items");
      assert.ok(schema, "items schema loads");
      assert.ok(
        !schema.fields.some((f) => f.name === "subsidiary_id"),
        "items carries no subsidiary dimension",
      );

      const updated = await withOrgContext(org.orgId, () =>
        updateRecord(user, resolved, schema.fields, itemId, {
          name: "Scope Probe Item Renamed",
        }),
      );
      assert.equal(updated.status, 200);

      const deleted = await withOrgContext(org.orgId, () =>
        deleteRecord(user, resolved, itemId),
      );
      assert.equal(deleted.status, 200);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
