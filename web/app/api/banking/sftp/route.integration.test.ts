import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Real-route, live-PostgreSQL regression for the SFTP access-audit boundary:
 * login creation, password rotation, active toggle, deletion, and the platform
 * daemon configuration must each commit their mutation and secret-free
 * audit_log evidence in ONE transaction, so a forced audit-insert failure
 * leaves the row/config untouched. Authorization is the only mocked
 * dependency; every mutation, row lock, and rollback executes through the
 * production handlers and database implementation.
 */
const stateKey = Symbol.for("openbooks.sftp-route-test");
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
  const state = globalThis[Symbol.for('openbooks.sftp-route-test')]
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
    // The identity source behind the REAL lib/feature-gates and
    // lib/super-admin authorities under test.
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

const serversUrl = "./route.ts?sftp-access-audit-test";
const { POST } = (await import(serversUrl)) as typeof import("./route.ts");
const itemUrl = "./[id]/route.ts?sftp-access-audit-test";
const { PATCH, DELETE } = (await import(itemUrl)) as typeof import(
  "./[id]/route.ts"
);
const daemonUrl = "../../platform/sftp/daemon/route.ts?sftp-access-audit-test";
const { PATCH: PLATFORM_PATCH } = (await import(daemonUrl)) as typeof import(
  "../../platform/sftp/daemon/route.ts"
);
hooks.deregister();

const { db, withBypass, withBypassContext, withOrgContext } =
  await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/src/test-fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(
      org.orgId,
      "SFTP Setup Admin",
      "sftp_setup_admin",
    );
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,bankFeeds}', 'true'::jsonb)
       where id = ${org.orgId}`);
    return { orgId: org.orgId, actorId };
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

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const post = (fixture: Fixture, body: unknown) =>
  withOrgContext(fixture.orgId, () =>
    POST(
      jsonRequest("http://openbooks.test/api/banking/sftp", "POST", body),
    ),
  );

const patch = (fixture: Fixture, id: string, body: unknown) =>
  withOrgContext(fixture.orgId, () =>
    PATCH(jsonRequest(`http://openbooks.test/api/banking/sftp/${id}`, "PATCH", body), {
      params: Promise.resolve({ id }),
    }),
  );

const del = (fixture: Fixture, id: string, body?: unknown) =>
  withOrgContext(fixture.orgId, () =>
    DELETE(
      new Request(`http://openbooks.test/api/banking/sftp/${id}`, {
        method: "DELETE",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );

const daemonPatch = (fixture: Fixture, body: unknown) =>
  withOrgContext(fixture.orgId, () =>
    PLATFORM_PATCH(
      jsonRequest("http://openbooks.test/api/platform/sftp/daemon", "PATCH", body),
    ),
  );

type AuditRow = {
  table_name: string;
  row_id: string;
  action: string;
  changes: Record<string, unknown>;
  actor_id: string;
  org_id: string;
  at: string | Date;
};

function auditsFor(fixture: Fixture): Promise<AuditRow[]> {
  return withOrgContext(fixture.orgId, async () => {
    const r = await db.execute<AuditRow>(sql`
      select table_name, row_id, action, changes, actor_id, org_id, at
        from audit_log
       where org_id = ${fixture.orgId}
         and table_name in ('sftp_servers', 'sftp_daemon')`);
    return r.rows;
  });
}

async function installAuditFailure(actorId: string): Promise<() => Promise<void>> {
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const functionName = `sftp_audit_failure_${suffix}`;
  const triggerName = `sftp_audit_failure_trigger_${suffix}`;
  await withBypassContext(() =>
    db.execute(
      sql.raw(`
      create function public."${functionName}"() returns trigger
      language plpgsql as $$
      begin
        if new.table_name = 'sftp_servers' and new.actor_id = '${actorId}'::uuid then
          raise exception 'forced sftp audit failure';
        end if;
        return new;
      end $$;
      create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function public."${functionName}"();
    `),
    ),
  );
  return async () => {
    await withBypassContext(() =>
      db.execute(
        sql.raw(`
        drop trigger if exists "${triggerName}" on audit_log;
        drop function if exists public."${functionName}"();
      `),
      ),
    );
  };
}

/** The pg error rides inside drizzle's DrizzleQueryError cause. */
function isForcedAuditFailure(error: unknown): boolean {
  const e = error as { message?: string; cause?: { message?: string } };
  return (
    /forced sftp audit failure/.test(e?.message ?? "") ||
    /forced sftp audit failure/.test(e?.cause?.message ?? "")
  );
}

test(
  "a forced audit-insert failure rolls the SFTP credential mutation back with no evidence written",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    let removeFailure: (() => Promise<void>) | undefined;
    try {
      authorize(fixture);
      const serverId = randomUUID();
      await withBypass(async () => {
        await db.execute(sql`
          insert into sftp_servers
            (id, org_id, name, username, password_encrypted, backend, root_prefix, created_by, updated_by)
          values
            (${serverId}, ${fixture.orgId}, 'Forced Failure Bank', 'forced-failure-bank',
             'seed-cipher-text', 'local', 'sftp/forced-failure', ${fixture.actorId}, ${fixture.actorId})`);
      });
      const before = await withOrgContext(fixture.orgId, async () => {
        const r = await db.execute<Record<string, unknown>>(sql`
          select * from sftp_servers where id = ${serverId} and org_id = ${fixture.orgId}`);
        return r.rows[0]!;
      });
      removeFailure = await installAuditFailure(fixture.actorId);

      // Password rotation must fail with the credential row untouched.
      await assert.rejects(
        () => patch(fixture, serverId, { action: "rotate" }),
        isForcedAuditFailure,
      );
      const after = await withOrgContext(fixture.orgId, async () => {
        const r = await db.execute<Record<string, unknown>>(sql`
          select * from sftp_servers where id = ${serverId} and org_id = ${fixture.orgId}`);
        return r.rows[0]!;
      });
      assert.deepEqual(
        after,
        before,
        "a failed audit insert must leave password_encrypted, attribution, and every other column exactly as it was",
      );
      assert.deepEqual(
        await auditsFor(fixture),
        [],
        "no audit evidence may survive the rolled-back rotation",
      );
    } finally {
      routeState.authz = null;
      routeState.identity = null;
      await removeFailure?.();
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "the SFTP access lifecycle and daemon configuration leave exact redacted attributable evidence",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const authorizedKeysBody =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFORCEDKEYMATERIAL0000000000000000000000000000000000000000000 sftp@openbooks.test";
      const created = await post(fixture, {
        name: "Main Bank Feed",
        authorizedKeys: authorizedKeysBody,
      });
      assert.equal(created.status, 200);
      const creation = (await created.json()) as {
        id: string;
        username: string;
        password: string;
        rootPrefix: string;
        backend: string;
      };
      assert.match(creation.username, /^main-bank-feed-/);
      assert.ok(creation.password.length >= 18);
      assert.equal(creation.backend, "local");

      const serverRow = await withOrgContext(fixture.orgId, async () => {
        const r = await db.execute<{
          password_encrypted: string;
          authorized_keys: string;
        }>(sql`
          select password_encrypted, authorized_keys from sftp_servers
           where id = ${creation.id} and org_id = ${fixture.orgId}`);
        return r.rows[0]!;
      });
      assert.notEqual(serverRow.password_encrypted, creation.password);

      const rotated = await patch(fixture, creation.id, { action: "rotate" });
      assert.equal(rotated.status, 200);
      const rotation = (await rotated.json()) as {
        username: string;
        password: string;
      };
      assert.equal(rotation.username, creation.username);
      assert.notEqual(rotation.password, creation.password);

      const toggled = await patch(fixture, creation.id, {
        action: "toggle",
        isActive: false,
      });
      assert.equal(toggled.status, 200);
      assert.deepEqual(await toggled.json(), { ok: true });

      const deleted = await del(fixture, creation.id, {
        reason: "quarter-end cleanup",
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { ok: true });
      const remaining = await withOrgContext(fixture.orgId, async () => {
        const r = await db.execute<{ count: number }>(sql`
          select count(*)::int as count from sftp_servers
           where id = ${creation.id} and org_id = ${fixture.orgId}`);
        return r.rows[0]!.count;
      });
      assert.equal(remaining, 0, "the login must actually be deleted");

      // The platform daemon configuration surface, after the tenant lifecycle.
      // The singleton row is global and survives test runs — reset it so the
      // evidence's before-state is deterministic.
      await withBypassContext(() =>
        db.execute(sql`
          update sftp_daemon
             set enabled = false, port = 2222, advertised_host = null,
                 updated_at = now(), updated_by = null
           where id = 'default'`),
      );
      const daemon = await daemonPatch(fixture, {
        advertisedHost: "sftp.openbooks.test",
      });
      assert.equal(daemon.status, 200);
      assert.deepEqual(await daemon.json(), {
        ok: true,
        enabled: false,
        port: 2222,
        advertisedHost: "sftp.openbooks.test",
      });
      const daemonRow = await withOrgContext(fixture.orgId, async () => {
        const r = await db.execute<{
          advertised_host: string;
          updated_by: string;
          host_key: string;
        }>(sql`
          select advertised_host, updated_by, host_key from sftp_daemon where id = 'default'`);
        return r.rows[0]!;
      });
      assert.equal(daemonRow.advertised_host, "sftp.openbooks.test");
      assert.equal(daemonRow.updated_by, fixture.actorId);

      const audits = await auditsFor(fixture);
      const serverAudits = audits.filter((a) => a.table_name === "sftp_servers");
      assert.equal(
        serverAudits.length,
        4,
        "create, rotate, toggle, and delete each leave one evidence row",
      );
      const byKey = new Map(
        serverAudits.map((a) => [
          a.action === "update" && a.changes.credentialRotated === true
            ? "rotate"
            : a.action,
          a,
        ]),
      );
      const insertAudit = byKey.get("insert");
      const rotateAudit = byKey.get("rotate");
      const toggleAudit = byKey.get("update");
      const deleteAudit = byKey.get("delete");
      assert.ok(insertAudit && rotateAudit && toggleAudit && deleteAudit);
      for (const audit of audits) {
        assert.equal(audit.org_id, fixture.orgId);
        assert.ok(
          !Number.isNaN(Date.parse(String(audit.at))),
          "evidence must carry a timestamp",
        );
      }
      for (const audit of [insertAudit, rotateAudit, toggleAudit, deleteAudit]) {
        assert.equal(audit!.actor_id, fixture.actorId);
        assert.equal(audit!.row_id, creation.id);
      }

      const redactedServer = (isActive: boolean) => ({
        name: "Main Bank Feed",
        username: creation.username,
        backend: "local",
        bucket: null,
        root_prefix: creation.rootPrefix,
        is_active: isActive,
        password_encrypted: "[redacted]",
        authorized_keys: "[redacted]",
        created_by: fixture.actorId,
        updated_by: fixture.actorId,
      });
      assert.deepEqual(insertAudit!.changes, {
        after: redactedServer(true),
      });
      assert.deepEqual(rotateAudit!.changes, {
        before: redactedServer(true),
        after: redactedServer(true),
        credentialRotated: true,
      });
      assert.deepEqual(toggleAudit!.changes, {
        before: redactedServer(true),
        after: redactedServer(false),
      });
      assert.deepEqual(deleteAudit!.changes, {
        before: redactedServer(false),
        reason: "quarter-end cleanup",
      });

      const daemonAudits = audits.filter((a) => a.table_name === "sftp_daemon");
      assert.equal(daemonAudits.length, 1);
      assert.equal(daemonAudits[0]!.actor_id, fixture.actorId);
      assert.equal(daemonAudits[0]!.org_id, fixture.orgId);
      assert.match(daemonAudits[0]!.row_id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(daemonAudits[0]!.changes, {
        before: { enabled: false, port: 2222, advertised_host: null },
        after: {
          enabled: false,
          port: 2222,
          advertised_host: "sftp.openbooks.test",
        },
      });

      // No secret material — plaintext, ciphertext, key bodies — anywhere in
      // the evidence, for either surface.
      const allEvidence = JSON.stringify(
        audits.map((a) => ({ table: a.table_name, changes: a.changes })),
      );
      for (const secret of [
        creation.password,
        rotation.password,
        serverRow.password_encrypted,
        serverRow.authorized_keys,
        authorizedKeysBody,
        daemonRow.host_key,
        "PRIVATE KEY",
      ]) {
        assert.ok(
          !allEvidence.includes(secret),
          `audit evidence must never contain secret material (found ${secret.slice(0, 12)}…)`,
        );
      }
    } finally {
      routeState.authz = null;
      routeState.identity = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);
