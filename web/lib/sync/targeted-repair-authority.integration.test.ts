import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveAppModule } from "../test-module-hooks";
import { stubModules } from "../../testing/stub-modules";

const root = pathToFileURL(process.cwd() + "/").href;
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: { "server-only": "" },
});
registerHooks({
  resolve(specifier, context, next) {
    return resolveAppModule(specifier, context, next, root) ?? next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, grantScratchPermissions, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { requestConnectionRun } = await import("./connection-run");

test(
  "bounded source repair refuses unauthorized, inactive and restricted actors through live native authority",
  {
    skip: !process.env.OPENBOOKS_DB_URL,
  },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(org.orgId, "Source repair reviewer", "source_repair_reviewer"),
      );
      const connectionId = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into connections(id,org_id,source,display_name,status,config,mirror_enabled)
      values(${connectionId},${org.orgId},'netsuite','Retained source','paused','{}'::jsonb,false)
    `),
      );
      const command = () =>
        withOrgContext(org.orgId, () =>
          requestConnectionRun(
            { orgId: org.orgId, userId: actor },
            connectionId,
            "targeted_repair",
            { sourceRefs: ["722205"] },
          ),
        );
      const before = (
        await withBypassContext(() =>
          db.execute<{ n: string }>(
            sql`
      select count(*)::text as n from sync_runs where org_id=${org.orgId}`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(
        (await command()).status,
        403,
        "a current local user without sync.run cannot enqueue",
      );
      await withBypassContext(() => grantScratchPermissions(org.orgId, actor, ["sync.run"]));
      await withBypassContext(() =>
        db.execute(sql`
      update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
      where org_id=${org.orgId} and key='source_repair_reviewer'
    `),
      );
      assert.equal(
        (await command()).status,
        403,
        "a single-entity grant cannot authorize whole-document source imports",
      );
      await withBypassContext(() =>
        db.execute(sql`
      update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='source_repair_reviewer'
    `),
      );
      await withBypassContext(() =>
        db.execute(sql`update users set is_active=false where org_id=${org.orgId} and id=${actor}`),
      );
      assert.equal((await command()).status, 403, "an inactive actor cannot use a retained grant");
      const missing = await withOrgContext(org.orgId, () =>
        requestConnectionRun({ orgId: org.orgId, userId: actor }, randomUUID(), "targeted_repair", {
          sourceRefs: ["722205"],
        }),
      );
      assert.equal(missing.status, 404);
      const after = (
        await withBypassContext(() =>
          db.execute<{ n: string }>(
            sql`
      select count(*)::text as n from sync_runs where org_id=${org.orgId}`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(after, before, "authority refusals create no sync run or cursor transition");
      const connection = (
        await withBypassContext(() =>
          db.execute<{ status: string; cursor: unknown; mirrorEnabled: boolean }>(
            sql`
      select status,cursor,mirror_enabled as "mirrorEnabled" from connections where org_id=${org.orgId} and id=${connectionId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(connection, { status: "paused", cursor: null, mirrorEnabled: false });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
