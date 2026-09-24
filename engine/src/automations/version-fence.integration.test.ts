import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  createAutomation,
  updateAutomation,
  AutomationVersionConflictError,
} from "./services.ts";

/**
 * F4T-12 DB coverage (integration partition): the recipe save carries a
 * version fence. A fresh save writes and bumps; a save over a moved recipe
 * writes nothing and refuses with the stored version named; the stored row
 * keeps the winner's values (read back from storage, never from service
 * returns alone); saves that predate the fence keep the old behavior.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function setupHarness(): Promise<{ org: ScratchOrg; adminId: string }> {
  const org = await createScratchOrg();
  const adminId = await createScratchUser(org.orgId, "Automation Fence Admin", "auto_fence_admin");
  await grant(org.orgId, adminId, ["automations.read", "automations.manage"]);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb), '{features}',
         coalesce(settings -> 'features', '{}'::jsonb) || '{"automations":true}'::jsonb
       )
     where id = ${org.orgId}
  `);
  return { org, adminId };
}

async function withHarness(fn: (h: { org: ScratchOrg; adminId: string }) => Promise<void>): Promise<void> {
  const h = await withBypassContext(() => setupHarness());
  try {
    await fn(h);
  } finally {
    await withBypassContext(() => dropScratchOrg(h.org.orgId));
  }
}

async function storedName(orgId: string, id: string): Promise<{ name: string; version: number }> {
  const rows = (
    await db.execute<{ name: string; version: number }>(sql`
      select name, version from automations where org_id = ${orgId} and id = ${id}
    `)
  ).rows;
  return { name: rows[0]!.name, version: rows[0]!.version };
}

test("a fresh save writes and bumps the version", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "fence probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "fired" }],
    });
    const saved = await updateAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      name: "fence probe renamed",
      expectedVersion: recipe.version,
    });
    assert.equal(saved.version, recipe.version + 1);
    assert.equal((await storedName(h.org.orgId, recipe.id)).name, "fence probe renamed");
  });
});

test("a save over a moved recipe writes nothing and names the stored version", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "fence probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "fired" }],
    });
    const winner = await updateAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      name: "winner",
      expectedVersion: recipe.version,
    });
    await assert.rejects(
      updateAutomation({
        orgId: h.org.orgId,
        actorId: h.adminId,
        automationId: recipe.id,
        name: "loser",
        expectedVersion: recipe.version,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AutomationVersionConflictError);
        assert.equal(error.currentVersion, winner.version);
        assert.match(error.message, /now at version/);
        return true;
      },
    );
    // The loser's write landed nowhere: storage still holds the winner.
    assert.deepEqual(await storedName(h.org.orgId, recipe.id), {
      name: "winner",
      version: winner.version,
    });
  });
});

test("a save without a version keeps the old behavior", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "fence probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "fired" }],
    });
    const saved = await updateAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      name: "legacy save",
    });
    assert.equal(saved.version, recipe.version + 1);
  });
});
