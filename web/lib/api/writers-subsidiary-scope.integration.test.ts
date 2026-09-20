import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { ResolvedApiType } from "./registry-data.ts";

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
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { deleteRecord, updateRecord } = await import("./writers.ts");
const { createAppPlatformAdapter } = await import("../apps/platform.ts");
const { loadApiSchema, resolveApiType } = await import("./schema-registry.ts");
const { db, env, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
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

test(
  "a restricted caller cannot update or delete a stored JSON subsidiary_id after the type drops the field",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `writerdrop-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const hiddenId = randomUUID();
    const visibleId = randomUUID();
    const hiddenDraftId = randomUUID();
    const { org, actorId, branch } = await withBypass(async () => {
      const created = await createScratchOrg();
      const actor = (await seedFlowActors(created.orgId)).adminId;
      const branch = randomUUID();
      const typeId = randomUUID();
      const fields = [{
        id: "main",
        title: "Details",
        fields: [{ id: "title", type: "text", label: "Title" }],
      }];
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Writer Drop Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${typeKey}, 'Writer Dropped', 'Writer Dropped',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `);
      for (const [id, subsidiaryId, title, status] of [
        [visibleId, created.subsidiaryId, "visible", "active"] as const,
        [hiddenId, branch, "hidden", "active"] as const,
        [hiddenDraftId, branch, "hidden-draft", "draft"] as const,
      ]) {
        await db.execute(sql`
          insert into custom_records
            (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
          values
            (${id}, ${created.orgId}, ${typeId}, ${typeKey}, ${id},
             ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
             ${title}, ${status}, ${actor}, ${actor})
        `);
      }
      return { org: created, actorId: actor, branch };
    });

    const { documentRevisionCounterSql } = await import("@openbooks/engine/src/records/revision.ts");
    const revisionOf = async (id: string) => {
      const rows = await db.execute<{ revision: string }>(sql`
        select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
          from custom_records where id = ${id}
      `);
      return rows.rows[0]!.revision;
    };
    const resolved: ResolvedApiType = {
      key: typeKey,
      table: "custom_records",
      searchColumn: "search_text",
      readPermission: "records.read",
      writePermission: "records.manage",
      operations: ["list", "get", "create", "update", "delete"],
      writer: { kind: "custom_record" as const },
      dynamic: true,
      documentKinds: null,
    };
    const user = {
      id: actorId,
      email: "writer-drop@scratch.test",
      name: "Writer Drop Caller",
      roles: [{ key: "admin", name: "Admin" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };
    const fence = { allowedSubsidiaryIds: new Set([org.subsidiaryId]) };

    try {
      await withOrgContext(org.orgId, async () => {
        const hiddenUpdate = await updateRecord(
          user,
          resolved,
          [],
          hiddenId,
          { data: { title: "smuggled" }, expectedUpdatedAt: await revisionOf(hiddenId) },
          fence,
        );
        assert.equal(hiddenUpdate.status, 404, JSON.stringify(hiddenUpdate.body));
        const hiddenDelete = await deleteRecord(user, resolved, hiddenDraftId, fence);
        assert.equal(hiddenDelete.status, 404, JSON.stringify(hiddenDelete.body));
        const stored = (await db.execute<{ title: string; n: string }>(sql`
          select data ->> 'title' as title, (select count(*)::text from custom_records where id = ${hiddenDraftId}) as n
            from custom_records where id = ${hiddenId}
        `)).rows[0];
        assert.equal(stored?.title, "hidden");
        assert.equal(stored?.n, "1");

        const visibleUpdate = await updateRecord(
          user,
          resolved,
          [],
          visibleId,
          { data: { title: "kept" }, expectedUpdatedAt: await revisionOf(visibleId) },
          fence,
        );
        assert.equal(visibleUpdate.status, 200, JSON.stringify(visibleUpdate.body));
        const after = (await db.execute<{ title: string; subsidiary_id: string | null }>(sql`
          select data ->> 'title' as title, data ->> 'subsidiary_id' as subsidiary_id
            from custom_records where id = ${visibleId}
        `)).rows[0];
        assert.equal(after?.title, "kept");
        assert.equal(
          after?.subsidiary_id,
          org.subsidiaryId,
          "an in-scope update after field-drop must not erase the stored JSON subsidiary_id",
        );

        const other = createAppPlatformAdapter({
          orgId: org.orgId,
          user,
          grantedPermissions: ["records.read"],
          userCan: () => true,
          allowedSubsidiaryIds: new Set([branch]),
        });
        const listed = (await other.list(typeKey, {})) as { records: Array<{ id: string }>; total: number };
        assert.equal(
          listed.records.some((row) => row.id === visibleId),
          false,
          "a restricted other-subsidiary caller must not list the updated row",
        );
        assert.equal(await other.get(typeKey, visibleId), null);
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
