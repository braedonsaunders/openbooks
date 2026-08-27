import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const routeState = Symbol.for("openbooks-payment-links-route-test");
;(globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] = {
  authz: null as { user: { orgId: string; id: string } } | null,
};

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks-payment-links-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return { ...state.authz, permissions: new Set(), allowedSubsidiaryIds: null }
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("payments/links")) {
      return { url: "mock:payment-links-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:payment-links-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?payment-links-boundary-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/test-fixtures.ts",
);

function request(body: unknown): Request {
  return new Request("http://localhost/api/payments/links", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("payment-link API rejects a malformed bank reference before any link write", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Payment links", "admin");
  try {
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"onlinePayments":true}'::jsonb)
       where id = ${org.orgId}
    `);
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = { user: { orgId: org.orgId, id: actorId } };

    const before = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from payment_links where org_id = ${org.orgId}
    `);
    const response = await POST(request({
      provider: "stripe",
      documentId: randomUUID(),
      bankAccountId: "not-a-uuid",
    }));
    assert.equal(response.status, 400);
    const after = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from payment_links where org_id = ${org.orgId}
    `);
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
  } finally {
    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[routeState] as {
      authz: { user: { orgId: string; id: string } } | null;
    };
    state.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
