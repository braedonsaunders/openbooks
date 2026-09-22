import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The unsaved-create write path at the real boundary: only the session gate
// is stubbed. Opening the drawer (?partyNew=1) writes nothing by
// construction (no endpoint is hit), Cancel writes nothing (router-only), and
// this POST is the single write — idempotent, tenant-scoped, and audited.

const stateKey = Symbol.for("openbooks.parties-create-integration");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.parties-create-integration')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function subsidiariesInScope() { return true }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
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

const postRouteUrl = "./route.ts?parties-create-integration";
const { POST } = (await import(postRouteUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function postRequest(key: string, body: unknown): Request {
  return new Request("http://localhost/api/parties", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

async function auditInserts(orgId: string, rowId: string): Promise<{ request_id: string | null; actor_id: string | null }[]> {
  return (
    await db.execute<{ request_id: string | null; actor_id: string | null }>(sql`
      select request_id, actor_id from audit_log
       where org_id = ${orgId} and table_name = 'parties' and row_id = ${rowId} and action = 'insert'
       order by at asc
    `)
  ).rows;
}

test(
  "parties POST creates one active party with its role and one audit row",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

      const key = randomUUID();
      const created = await POST(
        postRequest(key, {
          displayName: "Acme Corp",
          kind: "company",
          roles: { customer: { enabled: true } },
        }),
      );
      assert.equal(created.status, 201);
      const payload = (await created.json()) as { party: { id: string; display_name: string; is_active: boolean } };
      assert.equal(payload.party.id, key);
      assert.equal(payload.party.display_name, "Acme Corp");
      assert.equal(payload.party.is_active, true);

      const role = (
        await db.execute<{ party_id: string }>(sql`
          select party_id from customer_roles where party_id = ${key} and org_id = ${org.orgId} and is_active
        `)
      ).rows;
      assert.equal(role.length, 1, "the customer role is created active with the party");

      const audits = await auditInserts(org.orgId, key);
      assert.equal(audits.length, 1, "exactly one insert audit row");
      assert.equal(audits[0]?.request_id, key, "the audit row carries the idempotency key");
      assert.equal(audits[0]?.actor_id, adminId, "the audit row carries the actor");

      // Same request replays to the same party without a second audit event.
      const replay = await POST(
        postRequest(key, {
          displayName: "Acme Corp",
          kind: "company",
          roles: { customer: { enabled: true } },
        }),
      );
      assert.equal(replay.status, 200);
      assert.equal((await auditInserts(org.orgId, key)).length, 1, "a replay writes no second audit row");

      // A changed payload on the same key is a conflict, never the old party.
      const changed = await POST(
        postRequest(key, { displayName: "Acme Renamed", kind: "company" }),
      );
      assert.equal(changed.status, 409);
      assert.deepEqual(await changed.json(), { error: "invalid_idempotency_key" });

      // The create path never mints placeholder rows.
      const placeholders = (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from parties
           where org_id = ${org.orgId} and display_name in ('New party', 'New lead')
        `)
      ).rows[0]?.n;
      assert.equal(placeholders, 0, "no inactive placeholder survives the create path");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "parties POST refuses a key minted in another org",
  { skip: !DB },
  async () => {
    const orgA = await createScratchOrg();
    const orgB = await createScratchOrg();
    try {
      const { adminId: adminA } = await seedFlowActors(orgA.orgId);
      const { adminId: adminB } = await seedFlowActors(orgB.orgId);

      routeState.authz = { user: { orgId: orgA.orgId, id: adminA }, allowedSubsidiaryIds: null };
      const key = randomUUID();
      const created = await POST(postRequest(key, { displayName: "Acme Corp" }));
      assert.equal(created.status, 201);

      // Org B replays org A's key with the same body: no same-org row sits
      // behind it there, so the key reads as foreign, not as a replay.
      routeState.authz = { user: { orgId: orgB.orgId, id: adminB }, allowedSubsidiaryIds: null };
      const claimed = await POST(postRequest(key, { displayName: "Acme Corp" }));
      assert.equal(claimed.status, 409);
      assert.deepEqual(await claimed.json(), { error: "invalid_idempotency_key" });

      const leaked = (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from parties where id = ${key} and org_id = ${orgB.orgId}
        `)
      ).rows[0]?.n;
      assert.equal(leaked, 0, "org B gains no row from org A's key");
    } finally {
      await dropScratchOrg(orgA.orgId);
      await dropScratchOrg(orgB.orgId);
    }
  },
);
