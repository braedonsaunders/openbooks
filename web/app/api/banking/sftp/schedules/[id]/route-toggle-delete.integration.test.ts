import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * F05: SFTP schedule PATCH toggle / DELETE must refuse zero-row writes.
 *
 * The toggle branch (`{ isActive }`) and DELETE ignored the affected row
 * count, so a valid UUID for a missing or foreign-tenant schedule returned
 * 200 `{ok:true}` with no observable effect. Both must return the same
 * 404 `{error:'not found'}` the `action=run` branch already returns, keeping
 * other-org identifiers indistinguishable from absent (tenant
 * non-disclosure).
 *
 * Authorization (`./authz`) and the engine import scan are the only mocked
 * dependencies; every ownership check, write, and refusal executes through
 * the production handler, the real `parseJsonBody`/`isUuid`, and the real
 * database implementation.
 */
const stateKey = Symbol.for("openbooks.sftp-schedule-toggle-delete-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  identity: RouteState["authz"];
  runCalls: Array<{ orgId: string; scheduleId: string }>;
  deny(permission: string | null): NextResponse;
}
const routeState: RouteState = {
  authz: null,
  identity: null,
  runCalls: [],
  deny(permission) {
    return permission
      ? NextResponse.json(
          { error: `missing permission: ${permission}` },
          { status: 403 },
        )
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.sftp-schedule-toggle-delete-test')]
  export async function guardPermission(permission) {
    if (!state.authz) return state.deny(null)
    if (!state.authz.permissions.has('*') && !state.authz.permissions.has(permission)) {
      return state.deny(permission)
    }
    return state.authz
  }
  export async function getAuthz() {
    return state.identity
  }
`;

const mockImportJob = `
  const state = globalThis[Symbol.for('openbooks.sftp-schedule-toggle-delete-test')]
  export async function runDueSftpImports(orgId, scheduleId) {
    state.runCalls.push({ orgId, scheduleId })
    return [{ scheduleId, filesSeen: 0, imported: 0, duplicates: 0, errors: [], files: [] }]
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (
      specifier === "./authz" &&
      (context.parentURL?.includes("/lib/feature-gates") ||
        context.parentURL?.includes("/lib/super-admin"))
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/src/sftp/import-job.ts") {
      return { url: "mock:import-job", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(
        new URL(".", context.parentURL).href,
      );
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts")
          .href,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:import-job") {
      return { format: "module", source: mockImportJob, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const itemUrl = "./route.ts?sftp-schedule-toggle-delete-test";
const { PATCH, DELETE } = (await import(itemUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  bankAccountId: string;
}

async function seed(withFeature = true): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(
      org.orgId,
      "SFTP Schedule Admin",
      "sftp_schedule_admin",
    );
    if (withFeature) {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,bankFeeds}', 'true'::jsonb)
         where id = ${org.orgId}`);
    }
    return {
      orgId: org.orgId,
      actorId,
      bankAccountId: org.accounts.bank,
    };
  });
}

function authorize(fixture: Fixture, permissions = ["admin.setup.manage"]): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId, isSuperAdmin: false },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
  routeState.identity = {
    user: { orgId: fixture.orgId, id: fixture.actorId, isSuperAdmin: true },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
}

async function createSchedule(fixture: Fixture): Promise<string> {
  const scheduleId = randomUUID();
  const serverId = randomUUID();
  const name = `sched-feeder-${randomUUID().slice(0, 8)}`;
  await withBypass(async () => {
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, root_prefix, created_by, updated_by)
      values (${serverId}, ${fixture.orgId}, ${name}, ${name}, 'fleet', ${fixture.actorId}, ${fixture.actorId})`);
    await db.execute(sql`
      insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, created_by)
      values (${scheduleId}, ${fixture.orgId}, ${serverId}, ${fixture.bankAccountId}, ${fixture.actorId})`);
  });
  return scheduleId;
}

async function scheduleState(
  scheduleId: string,
): Promise<{ isActive: boolean } | null> {
  return withBypass(async () => {
    const r = await db.execute<{ is_active: boolean }>(
      sql`select is_active from sftp_import_schedules where id = ${scheduleId}`,
    );
    const row = r.rows[0];
    return row ? { isActive: row.is_active } : null;
  });
}

async function patchStatus(
  fixture: Fixture,
  id: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = (await withOrgContext(fixture.orgId, () =>
    PATCH(
      new Request(
        `http://openbooks.test/api/banking/sftp/schedules/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id }) },
    ),
  )) as NextResponse;
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function deleteStatus(
  fixture: Fixture,
  id: string,
): Promise<{ status: number; body: unknown }> {
  const res = (await withOrgContext(fixture.orgId, () =>
    DELETE(
      new Request(
        `http://openbooks.test/api/banking/sftp/schedules/${id}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id }) },
    ),
  )) as NextResponse;
  return { status: res.status, body: await res.json().catch(() => null) };
}

test(
  "schedule PATCH toggle flips is_active and reports success",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const scheduleId = await createSchedule(fixture);
      const outcome = await patchStatus(fixture, scheduleId, {
        isActive: false,
      });
      assert.equal(outcome.status, 200);
      assert.deepEqual(outcome.body, { ok: true });
      assert.deepEqual(await scheduleState(scheduleId), { isActive: false });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule PATCH toggle of a missing id refuses instead of reporting success",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const outcome = await patchStatus(fixture, randomUUID(), {
        isActive: false,
      });
      assert.equal(outcome.status, 404);
      assert.deepEqual(outcome.body, { error: "not found" });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule PATCH toggle of another organization's id reads as not found",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const other = await seed();
    try {
      authorize(fixture);
      const foreignId = await createSchedule(other);
      const foreign = await patchStatus(fixture, foreignId, {
        isActive: false,
      });
      const missing = await patchStatus(fixture, randomUUID(), {
        isActive: false,
      });
      assert.equal(foreign.status, 404);
      // Tenant non-disclosure: a foreign id is indistinguishable from absent.
      assert.deepEqual(foreign.body, missing.body);
      assert.deepEqual(await scheduleState(foreignId), { isActive: true });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

test(
  "schedule PATCH and DELETE refuse a malformed id without touching storage",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const scheduleId = await createSchedule(fixture);
      for (const outcome of [
        await patchStatus(fixture, "not-a-uuid", { isActive: false }),
        await deleteStatus(fixture, "not-a-uuid"),
      ]) {
        assert.equal(outcome.status, 404);
        assert.deepEqual(outcome.body, { error: "not found" });
      }
      assert.deepEqual(await scheduleState(scheduleId), { isActive: true });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule PATCH refuses a non-object body through the real JSON boundary",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const scheduleId = await createSchedule(fixture);
      const res = (await withOrgContext(fixture.orgId, () =>
        PATCH(
          new Request(
            `http://openbooks.test/api/banking/sftp/schedules/${scheduleId}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify([]),
            },
          ),
          { params: Promise.resolve({ id: scheduleId }) },
        ),
      )) as NextResponse;
      assert.equal(res.status, 400);
      assert.deepEqual(await scheduleState(scheduleId), { isActive: true });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule PATCH run keeps its contract: missing refuses, owned runs",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      routeState.runCalls.length = 0;
      const missing = await patchStatus(fixture, randomUUID(), {
        action: "run",
      });
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.body, { error: "not found" });
      assert.equal(routeState.runCalls.length, 0);

      const scheduleId = await createSchedule(fixture);
      const ran = await patchStatus(fixture, scheduleId, { action: "run" });
      assert.equal(ran.status, 200);
      assert.deepEqual(ran.body, {
        ok: true,
        result: {
          scheduleId,
          filesSeen: 0,
          imported: 0,
          duplicates: 0,
          errors: [],
          files: [],
        },
      });
      assert.deepEqual(routeState.runCalls, [
        { orgId: fixture.orgId, scheduleId },
      ]);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule PATCH and DELETE enforce permission and feature gates",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const featureOff = await seed(false);
    try {
      const scheduleId = await createSchedule(fixture);
      const gatedId = await createSchedule(featureOff);

      authorize(fixture, []);
      assert.equal(
        (await patchStatus(fixture, scheduleId, { isActive: false })).status,
        403,
      );
      assert.equal((await deleteStatus(fixture, scheduleId)).status, 403);
      assert.deepEqual(await scheduleState(scheduleId), { isActive: true });

      authorize(fixture);
      routeState.authz!.user.orgId = featureOff.orgId;
      const toggleOff = await patchStatus(featureOff, gatedId, {
        isActive: false,
      });
      assert.equal(toggleOff.status, 404);
      const deleteOff = await deleteStatus(featureOff, gatedId);
      assert.equal(deleteOff.status, 404);
      assert.deepEqual(await scheduleState(gatedId), { isActive: true });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(featureOff.orgId));
    }
  },
);

test(
  "schedule DELETE removes an owned schedule and reports success",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const scheduleId = await createSchedule(fixture);
      const outcome = await deleteStatus(fixture, scheduleId);
      assert.equal(outcome.status, 200);
      assert.deepEqual(outcome.body, { ok: true });
      assert.equal(await scheduleState(scheduleId), null);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule DELETE of a missing id refuses instead of reporting success",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const outcome = await deleteStatus(fixture, randomUUID());
      assert.equal(outcome.status, 404);
      assert.deepEqual(outcome.body, { error: "not found" });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule DELETE of another organization's id reads as not found",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const other = await seed();
    try {
      authorize(fixture);
      const foreignId = await createSchedule(other);
      const foreign = await deleteStatus(fixture, foreignId);
      const missing = await deleteStatus(fixture, randomUUID());
      assert.equal(foreign.status, 404);
      // Tenant non-disclosure: a foreign id is indistinguishable from absent.
      assert.deepEqual(foreign.body, missing.body);
      assert.deepEqual(await scheduleState(foreignId), { isActive: true });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);
