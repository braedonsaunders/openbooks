import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * F07: SFTP schedule creation must not save invisible orphan/cross-tenant
 * references.
 *
 * POST only checked UUID shapes before inserting, while GET and the import
 * scan join both parents by (org_id, id) with no parent FKs in storage. A
 * valid-shaped unknown or foreign-organization server or account id
 * therefore saved with 200 yet never appeared in GET and could never run.
 *
 * POST must fail closed before any write: unknown/foreign servers refuse
 * with 404 (indistinguishable from absent), unknown/foreign/ineligible
 * accounts refuse with the engine importStatement message at 422, and a
 * valid save is visible in GET with its server and account names.
 *
 * Authorization (`./authz`) is the only mocked dependency; every ownership
 * check, eligibility check, insert, and refusal executes through the
 * production handler, the real `parseJsonBody`/`isUuid`, and the real
 * database implementation.
 */
const stateKey = Symbol.for("openbooks.sftp-schedule-create-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  identity: RouteState["authz"];
  deny(permission: string | null): NextResponse;
}
const routeState: RouteState = {
  authz: null,
  identity: null,
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
  const state = globalThis[Symbol.for('openbooks.sftp-schedule-create-test')]
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
    return nextLoad(url, context);
  },
});

const itemUrl = "./route.ts?sftp-schedule-create-test";
const { POST, GET } = (await import(itemUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  /** Scratch fixture bank account: NOT reconcilable until a test opts in. */
  bankAccountId: string;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(
      org.orgId,
      "SFTP Schedule Creator",
      "sftp_schedule_creator",
    );
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,bankFeeds}', 'true'::jsonb)
       where id = ${org.orgId}`);
    return {
      orgId: org.orgId,
      actorId,
      bankAccountId: org.accounts.bank,
    };
  });
}

function authorize(fixture: Fixture): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId, isSuperAdmin: false },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
  routeState.identity = {
    user: { orgId: fixture.orgId, id: fixture.actorId, isSuperAdmin: true },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
}

/** A server owned by the given org, inside its own tenant namespace. */
async function createServer(fixture: Fixture): Promise<string> {
  const serverId = randomUUID();
  const name = `sched-parent-${randomUUID().slice(0, 8)}`;
  await withBypass(async () => {
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, root_prefix, created_by, updated_by)
      values (${serverId}, ${fixture.orgId}, ${name}, ${name}, ${`sftp/${fixture.orgId}/${name}`}, ${fixture.actorId}, ${fixture.actorId})`);
  });
  return serverId;
}

/** Promote an account to exactly what the engine import path accepts. */
async function makeReconcilable(
  fixture: Fixture,
  accountId: string,
): Promise<void> {
  await withBypass(async () => {
    await db.execute(sql`
      update accounts set reconcilable = true, currency_restriction = 'CAD'
       where id = ${accountId} and org_id = ${fixture.orgId}`);
  });
}

async function scheduleCount(fixture: Fixture): Promise<number> {
  return withBypass(async () => {
    const r = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from sftp_import_schedules where org_id = ${fixture.orgId}`,
    );
    return Number(r.rows[0]!.n);
  });
}

async function postStatus(
  fixture: Fixture,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = (await withOrgContext(fixture.orgId, () =>
    POST(
      new Request("http://openbooks.test/api/banking/sftp/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )) as NextResponse;
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function listSchedules(fixture: Fixture): Promise<unknown> {
  const res = (await withOrgContext(fixture.orgId, () =>
    GET(),
  )) as NextResponse;
  assert.equal(res.status, 200);
  return res.json();
}

test(
  "schedule POST refuses an unknown server id without side effect",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      await makeReconcilable(fixture, fixture.bankAccountId);
      const outcome = await postStatus(fixture, {
        sftpServerId: randomUUID(),
        accountId: fixture.bankAccountId,
        format: "ofx",
      });
      assert.equal(outcome.status, 404);
      assert.deepEqual(outcome.body, { error: "SFTP server not found" });
      assert.equal(await scheduleCount(fixture), 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule POST refuses another organization's server as not found",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const other = await seed();
    try {
      authorize(fixture);
      await makeReconcilable(fixture, fixture.bankAccountId);
      const foreignServerId = await createServer(other);
      const foreign = await postStatus(fixture, {
        sftpServerId: foreignServerId,
        accountId: fixture.bankAccountId,
        format: "ofx",
      });
      const missing = await postStatus(fixture, {
        sftpServerId: randomUUID(),
        accountId: fixture.bankAccountId,
        format: "ofx",
      });
      assert.equal(foreign.status, 404);
      // Tenant non-disclosure: a foreign id is indistinguishable from
      // absent — a REALISTIC second row, so the message proves it names
      // neither organization.
      assert.deepEqual(foreign.body, missing.body);
      assert.equal(await scheduleCount(fixture), 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

test(
  "schedule POST refuses an unknown account id without side effect",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const serverId = await createServer(fixture);
      const outcome = await postStatus(fixture, {
        sftpServerId: serverId,
        accountId: randomUUID(),
        format: "ofx",
      });
      assert.equal(outcome.status, 422);
      assert.deepEqual(outcome.body, {
        error: "Account not found or not reconcilable",
      });
      assert.equal(await scheduleCount(fixture), 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule POST refuses another organization's account like an unknown one",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const other = await seed();
    try {
      authorize(fixture);
      const serverId = await createServer(fixture);
      await makeReconcilable(other, other.bankAccountId);
      const foreign = await postStatus(fixture, {
        sftpServerId: serverId,
        accountId: other.bankAccountId,
        format: "ofx",
      });
      const missing = await postStatus(fixture, {
        sftpServerId: serverId,
        accountId: randomUUID(),
        format: "ofx",
      });
      assert.equal(foreign.status, 422);
      // Same engine message for missing, foreign, and ineligible — a
      // REALISTIC second account proves the refusal discloses nothing.
      assert.deepEqual(foreign.body, missing.body);
      assert.equal(await scheduleCount(fixture), 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

test(
  "schedule POST refuses a same-org account that cannot back an import",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const serverId = await createServer(fixture);
      // The scratch bank account is deliberately NOT reconcilable: it is a
      // real account of this org, yet importStatement would refuse it, so
      // the schedule must refuse it too — with the engine's own message.
      const outcome = await postStatus(fixture, {
        sftpServerId: serverId,
        accountId: fixture.bankAccountId,
        format: "ofx",
      });
      assert.equal(outcome.status, 422);
      assert.deepEqual(outcome.body, {
        error: "Account not found or not reconcilable",
      });
      assert.equal(await scheduleCount(fixture), 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule POST saves a valid schedule that GET shows with both parents",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const serverId = await createServer(fixture);
      await makeReconcilable(fixture, fixture.bankAccountId);
      const outcome = await postStatus(fixture, {
        sftpServerId: serverId,
        accountId: fixture.bankAccountId,
        format: "ofx",
      });
      assert.equal(outcome.status, 200);
      const createdId = (outcome.body as { id?: unknown }).id;
      assert.match(String(createdId), /^[0-9a-f-]{36}$/);
      const listing = (await listSchedules(fixture)) as {
        schedules: Array<{
          id: string;
          sftp_server_id: string;
          account_id: string;
          server_name: string;
          account_number: string;
        }>;
      };
      const mine = listing.schedules.find((row) => row.id === createdId);
      assert.ok(mine, "the saved schedule must be visible in GET");
      assert.equal(mine.sftp_server_id, serverId);
      assert.equal(mine.account_id, fixture.bankAccountId);
      assert.ok(mine.server_name, "GET resolves the owning server name");
      assert.ok(mine.account_number, "GET resolves the owning account number");
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "schedule POST still refuses malformed ids before any ownership check",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const outcome = await postStatus(fixture, {
        sftpServerId: "not-a-uuid",
        accountId: "not-a-uuid",
        format: "ofx",
      });
      assert.equal(outcome.status, 400);
      assert.deepEqual(outcome.body, {
        error: "sftpServerId and accountId are required",
      });
      assert.equal(await scheduleCount(fixture), 0);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);
