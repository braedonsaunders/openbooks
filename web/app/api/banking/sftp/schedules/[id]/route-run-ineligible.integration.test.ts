import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * F12: SFTP schedule manual run must not fabricate a successful empty scan.
 *
 * The run branch (`PATCH { action: 'run' }`) called `runDueSftpImports` and
 * answered `mine ?? { scheduleId, filesSeen: 0, ... }`, so every schedule the
 * engine deliberately excludes — inactive schedule, inactive server,
 * non-production org, disabled bankFeeds — reported 200 success with zero
 * counts. Zero is indistinguishable from "ran clean over an empty folder".
 *
 * The contract: a manual run over an eligible schedule returns the genuine
 * scan result (empty folder included); a run the engine cannot execute
 * refuses with 409 naming the exact ineligibility and its real remedy.
 * A scan that returns nothing for an apparently eligible schedule is a
 * stale race, not a success. Missing/foreign ids still read as 404.
 *
 * Authorization (`./authz`) and the engine import scan are the only mocked
 * dependencies; the scanner double returns ONLY the no-result shape the real
 * scanner produces for excluded schedules (or a genuine empty run where the
 * test says so). Ownership, eligibility diagnosis, and refusals execute
 * through the production handler, the real `parseJsonBody`/`isUuid`, and
 * real database rows (including genuinely inactive flags).
 */
const stateKey = Symbol.for("openbooks.sftp-schedule-run-ineligible-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  identity: RouteState["authz"];
  runCalls: Array<{ orgId: string; scheduleId: string }>;
  /** What the scanner double returns; defaults to [] (the real no-result). */
  runResult: Array<{
    scheduleId: string;
    filesSeen: number;
    imported: number;
    duplicates: number;
    errors: string[];
    files: Array<unknown>;
  }>;
  deny(permission: string | null): NextResponse;
}
const routeState: RouteState = {
  authz: null,
  identity: null,
  runCalls: [],
  runResult: [],
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
  const state = globalThis[Symbol.for('openbooks.sftp-schedule-run-ineligible-test')]
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
  const state = globalThis[Symbol.for('openbooks.sftp-schedule-run-ineligible-test')]
  export async function runDueSftpImports(orgId, scheduleId) {
    state.runCalls.push({ orgId, scheduleId })
    return state.runResult
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
      return { url: "mock:authz-f12", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/src/sftp/import-job.ts") {
      return { url: "mock:import-job-f12", shortCircuit: true };
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
    if (url === "mock:authz-f12") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:import-job-f12") {
      return { format: "module", source: mockImportJob, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const itemUrl = "./route.ts?sftp-schedule-run-ineligible-test";
const { PATCH } = (await import(itemUrl)) as typeof import("./route.ts");
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
      "SFTP Run Admin",
      "sftp_run_admin",
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

async function createSchedule(
  fixture: Fixture,
  opts: { scheduleActive?: boolean; serverActive?: boolean } = {},
): Promise<{ scheduleId: string; serverId: string }> {
  const scheduleId = randomUUID();
  const serverId = randomUUID();
  const name = `sched-run-${randomUUID().slice(0, 8)}`;
  await withBypass(async () => {
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, root_prefix, is_active, created_by, updated_by)
      values (${serverId}, ${fixture.orgId}, ${name}, ${name}, 'fleet', ${opts.serverActive !== false}, ${fixture.actorId}, ${fixture.actorId})`);
    await db.execute(sql`
      insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, is_active, created_by)
      values (${scheduleId}, ${fixture.orgId}, ${serverId}, ${fixture.bankAccountId}, ${opts.scheduleActive !== false}, ${fixture.actorId})`);
  });
  return { scheduleId, serverId };
}

async function runStatus(
  fixture: Fixture,
  id: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  routeState.runCalls.length = 0;
  routeState.runResult = [];
  const res = (await withOrgContext(fixture.orgId, () =>
    PATCH(
      new Request(
        `http://openbooks.test/api/banking/sftp/schedules/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "run" }),
        },
      ),
      { params: Promise.resolve({ id }) },
    ),
  )) as NextResponse;
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

test(
  "run refuses an inactive schedule instead of reporting a fabricated success",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const { scheduleId } = await createSchedule(fixture, {
        scheduleActive: false,
      });
      const outcome = await runStatus(fixture, scheduleId);
      assert.equal(outcome.status, 409);
      assert.equal(
        outcome.body?.error,
        "Activate this schedule before running it.",
      );
      assert.equal(outcome.body?.code, "SCHEDULE_INACTIVE");
      // The refusal enables nothing: the schedule stays inactive.
      const state = await withBypass(async () => {
        const r = await db.execute<{ is_active: boolean }>(
          sql`select is_active from sftp_import_schedules where id = ${scheduleId}`,
        );
        return r.rows[0];
      });
      assert.equal(state?.is_active, false);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "run refuses when the schedule's SFTP server is inactive",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const { scheduleId, serverId } = await createSchedule(fixture, {
        serverActive: false,
      });
      const outcome = await runStatus(fixture, scheduleId);
      assert.equal(outcome.status, 409);
      assert.equal(
        outcome.body?.error,
        "Activate the SFTP server before running this schedule.",
      );
      assert.equal(outcome.body?.code, "SFTP_SERVER_INACTIVE");
      // Neither the schedule nor the server is silently enabled.
      const state = await withBypass(async () => {
        const r = await db.execute<{ is_active: boolean }>(
          sql`select is_active from sftp_servers where id = ${serverId}`,
        );
        return r.rows[0];
      });
      assert.equal(state?.is_active, false);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "run refuses for a non-production organization",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const { scheduleId } = await createSchedule(fixture);
      await withBypass(async () => {
        await db.execute(
          sql`update orgs set env_kind = 'sandbox' where id = ${fixture.orgId}`,
        );
      });
      const outcome = await runStatus(fixture, scheduleId);
      assert.equal(outcome.status, 409);
      assert.equal(
        outcome.body?.error,
        "Manual SFTP runs are available only in production organizations.",
      );
      assert.equal(outcome.body?.code, "SFTP_RUN_NON_PRODUCTION");
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "run refuses when the scan returns nothing for an eligible schedule",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const { scheduleId } = await createSchedule(fixture);
      // The schedule is fully eligible, yet the scan came back with no run
      // (it was deactivated and reactivated around the scan, or the tick
      // raced the operator). That is stale, never a clean empty folder.
      const outcome = await runStatus(fixture, scheduleId);
      assert.equal(outcome.status, 409);
      assert.equal(
        outcome.body?.error,
        "The schedule changed while the run was starting — try running it again.",
      );
      assert.equal(outcome.body?.code, "SCHEDULE_RUN_STALE");
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "run keeps a genuinely executed empty scan a success",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const { scheduleId } = await createSchedule(fixture);
      routeState.runCalls.length = 0;
      routeState.runResult = [
        {
          scheduleId,
          filesSeen: 0,
          imported: 0,
          duplicates: 0,
          errors: [],
          files: [],
        },
      ];
      const res = (await withOrgContext(fixture.orgId, () =>
        PATCH(
          new Request(
            `http://openbooks.test/api/banking/sftp/schedules/${scheduleId}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "run" }),
            },
          ),
          { params: Promise.resolve({ id: scheduleId }) },
        ),
      )) as NextResponse;
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
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
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);
