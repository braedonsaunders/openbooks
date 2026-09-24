import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "../../../../lib/auth";

// Route boundary suite: saving or activating a trigger_point=scheduled
// script in a non-production org refuses by name (B2-SCH-2). The
// scheduled-script scanner only fires for production organizations, so an
// active schedule anywhere else would never run while the operator
// believes the automation is live. Mirrors the SFTP schedule refusal.

const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __scriptAdminEnvHunt: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "./auth" && (context.parentURL ?? "").endsWith("/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__scriptAdminEnvHunt.user}",
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { PATCH, POST } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function caller(orgId: string, userId: string): SessionUser {
  return {
    id: userId,
    email: `u-${userId.slice(0, 8)}@scratch.test`,
    name: "Script administrator",
    roles: [{ key: "script_admin", name: "script admin" }],
    orgId,
    envKind: "production",
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: userId,
    homeOrgId: orgId,
  };
}

async function enableScripts(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb)
     where id = ${orgId}`);
}

async function flagSandbox(orgId: string): Promise<void> {
  await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
}

async function grant(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function adminIn(orgId: string): Promise<void> {
  await enableScripts(orgId);
  const userId = await createScratchUser(orgId, "Script administrator", "script_admin");
  await grant(orgId, "script_admin", ["scripts.manage"]);
  session.user = caller(orgId, userId);
}

function postReq(body: Record<string, unknown>): Request {
  return new Request("http://audit.local/api/admin/scripts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchReq(body: Record<string, unknown>): Request {
  return new Request("http://audit.local/api/admin/scripts", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SOURCE = "function main(ctx) { return 1; }";

async function scriptCount(orgId: string): Promise<number> {
  return Number(
    (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from user_scripts where org_id = ${orgId}
    `)).rows[0]!.n,
  );
}

test("creating an active schedule in a sandbox org refuses by name with nothing written", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await adminIn(org.orgId);
    await flagSandbox(org.orgId);
    const res = await POST(postReq({
      name: "Nightly",
      triggerPoint: "scheduled",
      source: SOURCE,
      cron: "0 12 * * *",
      isActive: true,
    }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "scheduled scripts run only in production organizations — this organization is 'sandbox', " +
        "so an active schedule would never fire. Use Run now to exercise the script here, " +
        "or activate the schedule in a production organization.",
      code: "SCHEDULED_SCRIPT_NON_PRODUCTION",
      envKind: "sandbox",
    });
    assert.equal(await scriptCount(org.orgId), 0);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("a sandbox org can still stage an inactive schedule or another trigger", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await adminIn(org.orgId);
    await flagSandbox(org.orgId);
    const inactive = await POST(postReq({
      name: "Staged",
      triggerPoint: "scheduled",
      source: SOURCE,
      cron: "0 12 * * *",
      isActive: false,
    }));
    assert.equal(inactive.status, 200);
    assert.ok((await inactive.json() as { id: string }).id);
    const endpoint = await POST(postReq({
      name: "Hook",
      triggerPoint: "endpoint",
      endpointSlug: `hook-${randomUUID().slice(0, 8)}`,
      source: SOURCE,
      isActive: true,
    }));
    assert.equal(endpoint.status, 200);
    assert.equal(await scriptCount(org.orgId), 2);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("activating an inactive schedule in a sandbox org refuses; deactivation passes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await adminIn(org.orgId);
    await flagSandbox(org.orgId);
    const created = (await (await POST(postReq({
      name: "Staged",
      triggerPoint: "scheduled",
      source: SOURCE,
      cron: "0 12 * * *",
      isActive: false,
    }))).json()) as { id: string };
    const activate = await PATCH(patchReq({
      id: created.id,
      name: "Staged",
      triggerPoint: "scheduled",
      source: SOURCE,
      cron: "0 12 * * *",
      isActive: true,
    }));
    assert.equal(activate.status, 409);
    assert.equal((await activate.json() as { code: string }).code, "SCHEDULED_SCRIPT_NON_PRODUCTION");
    const row = (await db.execute<{ is_active: boolean }>(sql`
      select is_active from user_scripts where id = ${created.id}
    `)).rows[0]!;
    assert.equal(row.is_active, false);
    // A name-only edit to the inactive row is not an activation: it passes.
    const rename = await PATCH(patchReq({
      id: created.id,
      name: "Staged renamed",
      triggerPoint: "scheduled",
      source: SOURCE,
      cron: "0 12 * * *",
      isActive: false,
    }));
    assert.equal(rename.status, 200);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("a production org activates schedules unchanged (control)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await adminIn(org.orgId);
    const res = await POST(postReq({
      name: "Nightly",
      triggerPoint: "scheduled",
      source: SOURCE,
      cron: "0 12 * * *",
      isActive: true,
    }));
    assert.equal(res.status, 200);
    assert.ok((await res.json() as { id: string }).id);
    assert.equal(await scriptCount(org.orgId), 1);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});
