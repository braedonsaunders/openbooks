import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Real-route, live-PostgreSQL regression for non-overlapping SFTP server
 * roots: two bank logins must never share a folder (equal, ancestor, or
 * descendant prefixes), on create (POST) and on reactivation (PATCH
 * toggle). Authorization is the only mocked dependency; every refusal and
 * insert executes through the production handlers. RED before the fix: the
 * create route accepted any requestedPrefix under sftp/<org>/ with >= 3
 * segments, so both inserts below returned 200 and the logins shared one
 * folder despite separate credentials.
 */
const stateKey = Symbol.for("openbooks.sftp-route-overlap-test");
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
  const state = globalThis[Symbol.for('openbooks.sftp-route-overlap-test')]
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

const serversUrl = "./route.ts?sftp-root-overlap-test";
const { POST } = (await import(serversUrl)) as typeof import("./route.ts");
const itemUrl = "./[id]/route.ts?sftp-root-overlap-test";
const { PATCH } = (await import(itemUrl)) as typeof import(
  "./[id]/route.ts"
);
hooks.deregister();

const { db, env, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/src/testing/fixtures.ts");

// Creating a server resolves storage through the production selector, which
// requires an absolute shared OPENBOOKS_DATA_DIR (refuses by name
// otherwise): pin a throwaway directory for this file's POST calls, in both
// the live environment and the engine snapshot, and restore both after.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-route-overlap-"));
const savedProcessDataDir = process.env.OPENBOOKS_DATA_DIR;
const savedSnapshotDataDir = (env as Record<string, string | undefined>).OPENBOOKS_DATA_DIR;
process.env.OPENBOOKS_DATA_DIR = scratchDataDir;
(env as Record<string, string>).OPENBOOKS_DATA_DIR = scratchDataDir;
test.after(() => {
  if (savedProcessDataDir === undefined) delete process.env.OPENBOOKS_DATA_DIR;
  else process.env.OPENBOOKS_DATA_DIR = savedProcessDataDir;
  if (savedSnapshotDataDir === undefined) delete (env as Record<string, string | undefined>).OPENBOOKS_DATA_DIR;
  else (env as Record<string, string>).OPENBOOKS_DATA_DIR = savedSnapshotDataDir;
  rmSync(scratchDataDir, { recursive: true, force: true });
});

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

async function serverCount(fixture: Fixture): Promise<number> {
  const r = await withOrgContext(fixture.orgId, () =>
    db.execute<{ n: string }>(sql`select count(*)::text as n from sftp_servers where org_id = ${fixture.orgId}`),
  );
  return Number(r.rows[0]!.n);
}

test(
  "creating two servers on the same root refuses the second by name",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const root = `sftp/${fixture.orgId}/bank-a`;
      const first = await post(fixture, { name: "Bank A", rootPrefix: root });
      assert.equal(first.status, 200);
      const before = await serverCount(fixture);

      const second = await post(fixture, { name: "Bank A Replica", rootPrefix: root });
      assert.equal(second.status, 409);
      const body = (await second.json()) as { error: string; code: string };
      assert.equal(body.code, "sftp_root_overlap");
      assert.match(body.error, /Bank A/);
      assert.match(body.error, /bank-a/);
      // A refused create stores nothing: no read can observe it.
      assert.equal(await serverCount(fixture), before);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "nested roots refuse in both directions while siblings succeed",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const parent = `sftp/${fixture.orgId}/bank-a`;
      assert.equal((await post(fixture, { name: "Bank A", rootPrefix: parent })).status, 200);

      const child = await post(fixture, { name: "Bank A Sub", rootPrefix: `${parent}/sub` });
      assert.equal(child.status, 409);
      assert.match(((await child.json()) as { error: string }).error, /Bank A/);

      // The reverse: a candidate containing an existing root refuses too.
      // (A bare sftp/<org> never reaches the overlap gate — the route's
      // minimum-depth rule refuses it with 400 first.)
      const deep = `sftp/${fixture.orgId}/nested/deep`;
      assert.equal((await post(fixture, { name: "Deep", rootPrefix: deep })).status, 200);
      const wider = await post(fixture, { name: "Wide", rootPrefix: `sftp/${fixture.orgId}/nested` });
      assert.equal(wider.status, 409);
      assert.match(((await wider.json()) as { error: string }).error, /Deep/);

      const sibling = await post(fixture, { name: "Bank B", rootPrefix: `sftp/${fixture.orgId}/bank-b` });
      assert.equal(sibling.status, 200);
      // A near-miss prefix that only shares a string prefix is a sibling, not a child.
      const nearMiss = await post(fixture, { name: "Bank A2", rootPrefix: `sftp/${fixture.orgId}/bank-a2` });
      assert.equal(nearMiss.status, 200);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "two simultaneous first creates on one root give one success and one refusal",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      // No servers exist yet, so sibling row locks cover nothing: without
      // the per-org advisory lock several requests pass the overlap read
      // before any insert commits. Six contenders make that interleaving
      // near-certain; the gate must still serialize them into exactly one
      // server. The pool is warmed first so connection setup cannot stagger
      // the racers into an accidental sequence before the gate is reached.
      await Promise.all(
        Array.from({ length: 6 }, () =>
          withOrgContext(fixture.orgId, () => db.execute(sql`select 1`)),
        ),
      );
      const root = `sftp/${fixture.orgId}/race`;
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => post(fixture, { name: `Racer ${i}`, rootPrefix: root })),
      );
      const winners = responses.filter((r) => r.status === 200);
      const losers = responses.filter((r) => r.status === 409);
      assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);
      assert.equal(losers.length, 5);
      for (const loser of losers) {
        assert.equal(((await loser.json()) as { code: string }).code, "sftp_root_overlap");
      }
      assert.equal(await serverCount(fixture), 1);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "an inactive server does not block creation, but reactivation into an overlap refuses",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const root = `sftp/${fixture.orgId}/bank-a`;
      const first = (await (await post(fixture, { name: "Bank A", rootPrefix: root })).json()) as { id: string };
      assert.equal((await patch(fixture, first.id, { action: "toggle", isActive: false })).status, 200);

      // Inactive logins serve nothing, so the folder is free to reissue.
      const second = await post(fixture, { name: "Bank A New", rootPrefix: root });
      assert.equal(second.status, 200);

      // Waking the retired server would share the folder again: refuse by name.
      const wake = await patch(fixture, first.id, { action: "toggle", isActive: true });
      assert.equal(wake.status, 409);
      const body = (await wake.json()) as { error: string; code: string };
      assert.equal(body.code, "sftp_root_overlap");
      assert.match(body.error, /Bank A New/);
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);
