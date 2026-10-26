import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __sandboxScheduleUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/cache")
      return { shortCircuit: true, url: "data:text/javascript,export function revalidatePath(){}" };
    if (specifier === "./auth" && context.parentURL?.includes("/web/lib/authz"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__sandboxScheduleUser.user;}",
      };
    return next(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/platform/db");
const { sql } = await import(root + "node_modules/drizzle-orm/index.js");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } =
  await import("@openbooks/engine/testing/fixtures");
const { createSandbox, deleteSandbox } = await import("@openbooks/engine/sandbox/lifecycle");
const { setScheduleAction } = await import(root + "web/app/(app)/admin/sandboxes/actions.ts");

test(
  "sandbox refresh schedule changes leave actor-attributed audit evidence",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actorId = await createScratchUser(org.orgId, "Schedule manager", "admin");
      await db.execute(
        sql`update app_roles set permissions='["admin.sandboxes.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`,
      );
      sandbox = await createSandbox({
        productionOrgId: org.orgId,
        name: "Schedule audit",
        tier: "dev",
        masked: false,
      });
      state.user = {
        id: actorId,
        name: "Schedule manager",
        email: "schedule-manager@example.invalid",
        roles: [],
        orgId: org.orgId,
        productionOrgId: org.orgId,
        envKind: "production",
        isSuperAdmin: false,
        homeUserId: actorId,
        homeOrgId: org.orgId,
      };

      await setScheduleAction(sandbox.sandboxId, "daily");

      const evidence = (
        await db.execute<{ actor_id: string; changes: Record<string, unknown> }>(
          sql`
      select actor_id, changes
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'sandboxes'
         and row_id = ${sandbox.sandboxId}
         and action = 'update'
       order by at desc
       limit 1
    `,
          "objects",
        )
      )[0];
      assert.equal(evidence?.actor_id, actorId);
      assert.deepEqual(evidence?.changes, {
        before: { refresh_schedule: null },
        after: { refresh_schedule: "daily" },
      });
    } finally {
      state.user = null;
      if (sandbox) await deleteSandbox(sandbox.sandboxId);
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
