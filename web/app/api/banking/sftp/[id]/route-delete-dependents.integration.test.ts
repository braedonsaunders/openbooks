import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Wave-7 delete-contract regression for SFTP servers: a server that still
 * feeds live dependents must refuse deletion with a typed 409 naming them —
 * never a raw FK 500, and never a 200 that silently orphans rows.
 *
 * Dependents: payment bank profiles (payment_bank_profiles.sftp_server_id,
 * RESTRICT) and statement-import schedules
 * (sftp_import_schedules.sftp_server_id, no FK at all). Authorization is the
 * only mocked dependency; every row lock, delete, and rollback executes
 * through the production handler and database implementation.
 */
const stateKey = Symbol.for("openbooks.sftp-delete-dependents-test");
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
  const state = globalThis[Symbol.for('openbooks.sftp-delete-dependents-test')]
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

const itemUrl = "./route.ts?sftp-delete-dependents-test";
const { DELETE } = (await import(itemUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/src/test-fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  bankAccountId: string;
  subsidiaryId: string | null;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(
      org.orgId,
      "SFTP Delete Admin",
      "sftp_delete_admin",
    );
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,bankFeeds}', 'true'::jsonb)
       where id = ${org.orgId}`);
    return {
      orgId: org.orgId,
      actorId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
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

async function createServer(
  fixture: Fixture,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, root_prefix, created_by, updated_by)
      values (${id}, ${fixture.orgId}, ${name}, ${name}, 'fleet', ${fixture.actorId}, ${fixture.actorId})`);
  });
  return id;
}

async function attachBankProfile(
  fixture: Fixture,
  serverId: string,
): Promise<void> {
  const format = randomUUID();
  const profile = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`insert into payment_formats(id,org_id,code,name,rail,direction,country,currency,created_by,updated_by)
      values(${format},${fixture.orgId},'SFTPDEL','SftpDel','cpa005_credit','credit','CA','CAD',${fixture.actorId},${fixture.actorId})`);
    await db.execute(sql`insert into payment_bank_profiles(id,org_id,name,bank_account_id,subsidiary_id,payment_format_id,currency,country,sftp_server_id,created_by,updated_by)
      values(${profile},${fixture.orgId},'SftpDel',${fixture.bankAccountId},${fixture.subsidiaryId},${format},'CAD','CA',${serverId},${fixture.actorId},${fixture.actorId})`);
  });
}

async function attachSchedule(
  fixture: Fixture,
  serverId: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`insert into sftp_import_schedules(id,org_id,sftp_server_id,account_id,created_by)
      values(${id},${fixture.orgId},${serverId},${fixture.bankAccountId},${fixture.actorId})`);
  });
  return id;
}

/** A raw storage throw escapes the handler (the 500); normalize it for assertions. */
async function deleteStatus(
  fixture: Fixture,
  id: string,
): Promise<{ status: number | "threw"; body: unknown }> {
  try {
    const res = (await withOrgContext(fixture.orgId, () =>
      DELETE(
        new Request(`http://openbooks.test/api/banking/sftp/${id}`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id }) },
      ),
    )) as NextResponse;
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: "threw", body: null };
  }
}

async function serverExists(serverId: string): Promise<boolean> {
  return withBypass(async () => {
    const r = await db.execute(
      sql`select 1 from sftp_servers where id = ${serverId}`,
    );
    return r.rows.length === 1;
  });
}

test(
  "sftp server delete refuses a server that delivers a payment bank profile",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const serverId = await createServer(fixture, "profile-feeder");
      await attachBankProfile(fixture, serverId);
      const outcome = await deleteStatus(fixture, serverId);
      assert.equal(outcome.status, 409);
      assert.match(
        String(
          (outcome.body as { error?: string } | null)?.error ?? "",
        ),
        /bank profile/i,
      );
      assert.equal(
        await serverExists(serverId),
        true,
        "the refused delete must leave the server row untouched",
      );
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "sftp server delete refuses a server with import schedules instead of orphaning them",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const serverId = await createServer(fixture, "schedule-feeder");
      const scheduleId = await attachSchedule(fixture, serverId);
      const outcome = await deleteStatus(fixture, serverId);
      assert.equal(outcome.status, 409);
      assert.match(
        String(
          (outcome.body as { error?: string } | null)?.error ?? "",
        ),
        /import schedule/i,
      );
      assert.equal(
        await serverExists(serverId),
        true,
        "the refused delete must leave the server row untouched",
      );
      const schedule = await withBypass(() =>
        db.execute(
          sql`select sftp_server_id from sftp_import_schedules where id = ${scheduleId}`,
        ),
      );
      assert.equal(schedule.rows[0]?.sftp_server_id, serverId);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "sftp server delete removes an unreferenced server with audit evidence",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const serverId = await createServer(fixture, "lonely-server");
      const outcome = await deleteStatus(fixture, serverId);
      assert.equal(outcome.status, 200);
      assert.equal(await serverExists(serverId), false);
      const audits = await withOrgContext(fixture.orgId, () =>
        db.execute(
          sql`select action from audit_log where org_id = ${fixture.orgId} and table_name = 'sftp_servers' and row_id = ${serverId}`,
        ),
      );
      assert.deepEqual(
        audits.rows.map((row) => (row as { action: string }).action),
        ["delete"],
      );
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "sftp server delete of another organization's id reads as not found",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const other = await seed();
    try {
      authorize(fixture);
      const serverId = await withBypass(async () => {
        const id = randomUUID();
        await db.execute(sql`
          insert into sftp_servers (id, org_id, name, username, root_prefix, created_by, updated_by)
          values (${id}, ${other.orgId}, 'foreign', 'foreign', 'fleet', ${other.actorId}, ${other.actorId})`);
        return id;
      });
      const outcome = await deleteStatus(fixture, serverId);
      assert.equal(outcome.status, 404);
      assert.equal(await serverExists(serverId), true);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);
