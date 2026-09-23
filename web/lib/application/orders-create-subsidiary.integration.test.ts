import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// A v1 order create for a restricted key must never mint a NULL-subsidiary
// draft the same key cannot GET/list: the subsidiary is required (explicit)
// or derived (single visible subsidiary), otherwise refused.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createApplicationOrder } = await import("./orders.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function contextFor(orgId: string, actor: string, allowed: Set<string> | null): ApplicationContext {
  return {
    authz: {
      user: { id: actor, orgId, name: "Creator", email: "c@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor },
      permissions: new Set(["ap.create"]),
      allowedSubsidiaryIds: allowed,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: "key-1",
  };
}

async function subsidiaryOf(orgId: string, id: string): Promise<string | null> {
  const row = (await withBypassContext(() => db.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from documents where id = ${id} and org_id = ${orgId}`))).rows[0];
  return row?.subsidiary_id ?? null;
}

test("restricted create derives the single visible subsidiary", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Creator", "order_creator"));
    const ctx = contextFor(org.orgId, actor, new Set([org.subsidiaryId]));
    const outcome = await createApplicationOrder(ctx, { kind: "purchase_order", idempotencyKey: `create-derive-${randomUUID()}` });
    assert.equal(await subsidiaryOf(org.orgId, outcome.result.id), org.subsidiaryId);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("restricted create without a subsidiary is refused when scope is ambiguous", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Creator", "order_creator"));
    const hidden = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`));
    const ctx = contextFor(org.orgId, actor, new Set([org.subsidiaryId, hidden]));
    await assert.rejects(
      () => createApplicationOrder(ctx, { kind: "purchase_order", idempotencyKey: `create-amb-${randomUUID()}` }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "forbidden");
        assert.equal(error.status, 403);
        return true;
      },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("restricted create refuses an out-of-scope subsidiary and accepts an in-scope one", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Creator", "order_creator"));
    const hidden = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`));
    const ctx = contextFor(org.orgId, actor, new Set([org.subsidiaryId]));
    await assert.rejects(
      () => createApplicationOrder(ctx, { kind: "purchase_order", idempotencyKey: `create-out-${randomUUID()}`, subsidiaryId: hidden }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "forbidden");
        return true;
      },
    );
    const outcome = await createApplicationOrder(ctx, { kind: "purchase_order", idempotencyKey: `create-in-${randomUUID()}`, subsidiaryId: org.subsidiaryId });
    assert.equal(await subsidiaryOf(org.orgId, outcome.result.id), org.subsidiaryId);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("restricted create refuses a malformed subsidiary id", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Creator", "order_creator"));
    const ctx = contextFor(org.orgId, actor, new Set([org.subsidiaryId]));
    await assert.rejects(
      () => createApplicationOrder(ctx, { kind: "purchase_order", idempotencyKey: `create-bad-${randomUUID()}`, subsidiaryId: "not-a-uuid" }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "invalid_input");
        assert.equal(error.status, 422);
        return true;
      },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("unrestricted create keeps the established null subsidiary", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Creator", "order_creator"));
    const ctx = contextFor(org.orgId, actor, null);
    const outcome = await createApplicationOrder(ctx, { kind: "purchase_order", idempotencyKey: `create-open-${randomUUID()}` });
    assert.equal(await subsidiaryOf(org.orgId, outcome.result.id), null);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
