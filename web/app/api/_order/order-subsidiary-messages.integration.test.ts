import { documentRevisionCounterSql } from '@openbooks/engine/src/document-revision.ts';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: the shared order PATCH refused four distinct
// subsidiary failures with one sentence — 'Subsidiary is not available' —
// whether the body carried a non-string, the target sat outside the caller's
// scope, the row was missing/inactive/elimination, or a restricted caller
// cleared the field. Each refusal must name which predicate failed.

const stateKey = Symbol.for("openbooks.order-subsidiary-test");
interface GateState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const gateState: GateState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = gateState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.order-subsidiary-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      specifier === "../../../lib/feature-gates" &&
      context.parentURL?.includes("/api/_order/handlers")
    ) {
      return { url: "mock:order-subsidiary-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:order-subsidiary-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { makePATCH } = await import("./handlers.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;
const PATCH = makePATCH({ kind: "quote", readPerm: "ar.read", createPerm: "ar.create" });

interface Fixture {
  orgId: string;
  actorId: string;
  orderId: string;
  rootSubsidiaryId: string;
  otherSubsidiaryId: string;
}

async function seedDraftQuote(tag: string): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const otherSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Other Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    // Pin the subsidiaries feature on: its default counts active
    // non-elimination subsidiaries, so deactivating the second one below
    // would otherwise switch the surface under test off mid-fixture.
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"multiSubsidiary": true}'::jsonb)
       where id = ${org.orgId}`);
    const orderId = randomUUID();
    await db.execute(sql`
      insert into documents(
        id, org_id, kind, document_number, document_date, party_id, subsidiary_id,
        currency, status, subtotal, tax_total, total, memo
      ) values (
        ${orderId}, ${org.orgId}, 'quote', ${tag}, ${org.date}, ${org.customerId},
        ${org.subsidiaryId}, 'CAD', 'draft', 0, 0, 0, 'Subsidiary-message terms'
      )
    `);
    return { orgId: org.orgId, actorId, orderId, rootSubsidiaryId: org.subsidiaryId, otherSubsidiaryId };
  });
}

async function patchRequest(
  fixture: Fixture,
  body: Record<string, unknown>,
  allowedSubsidiaryIds: Set<string> | null,
): Promise<Request> {
  gateState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds,
  };
  const revision = await withOrgContext(fixture.orgId, async () =>
    (await db.execute<{ revision: string }>(sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
        from documents where id = ${fixture.orderId}`)).rows[0]!.revision);
  return new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: revision, ...body }),
  });
}

async function patchError(
  fixture: Fixture,
  body: Record<string, unknown>,
  allowedSubsidiaryIds: Set<string> | null,
): Promise<{ status: number; error: string }> {
  const response = await withOrgContext(fixture.orgId, async () => PATCH(await patchRequest(fixture, body, allowedSubsidiaryIds), {
    params: Promise.resolve({ id: fixture.orderId }),
  }));
  return { status: response.status, error: ((await response.json()) as { error?: string }).error ?? "" };
}

test("order PATCH names a non-string subsidiary as a shape error", { skip: !DB }, async () => {
  const fixture = await seedDraftQuote("Q-SUB-1");
  try {
    const { status, error } = await patchError(fixture, { subsidiaryId: 12345 }, null);
    assert.equal(status, 422);
    assert.match(error, /order subsidiary must be a subsidiary id string/);
    assert.match(error, /received number/);
  } finally {
    gateState.authz = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names a subsidiary outside the caller's scope", { skip: !DB }, async () => {
  const fixture = await seedDraftQuote("Q-SUB-2");
  try {
    const { status, error } = await patchError(
      fixture,
      { subsidiaryId: fixture.otherSubsidiaryId },
      new Set([fixture.rootSubsidiaryId]),
    );
    assert.equal(status, 422);
    assert.match(error, new RegExp(`subsidiary "${fixture.otherSubsidiaryId}" is outside your visible subsidiaries`));
  } finally {
    gateState.authz = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names a subsidiary id that matches no row", { skip: !DB }, async () => {
  const fixture = await seedDraftQuote("Q-SUB-3");
  try {
    const missing = randomUUID();
    const { status, error } = await patchError(fixture, { subsidiaryId: missing }, null);
    assert.equal(status, 422);
    assert.match(error, new RegExp(`no subsidiary "${missing}" in this organization`));
  } finally {
    gateState.authz = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names an inactive and an elimination subsidiary", { skip: !DB }, async () => {
  const fixture = await seedDraftQuote("Q-SUB-4");
  try {
    await withBypassContext(async () => {
      await db.execute(sql`update subsidiaries set is_active = false where id = ${fixture.otherSubsidiaryId}`);
    });
    const dormant = await patchError(fixture, { subsidiaryId: fixture.otherSubsidiaryId }, null);
    assert.equal(dormant.status, 422);
    assert.match(dormant.error, /is inactive/);
    await withBypassContext(async () => {
      await db.execute(sql`update subsidiaries set is_active = true, is_elimination = true where id = ${fixture.otherSubsidiaryId}`);
    });
    const wash = await patchError(fixture, { subsidiaryId: fixture.otherSubsidiaryId }, null);
    assert.equal(wash.status, 422);
    assert.match(wash.error, /is an elimination entity/);
  } finally {
    gateState.authz = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names clearing the subsidiary under restricted scope", { skip: !DB }, async () => {
  const fixture = await seedDraftQuote("Q-SUB-5");
  try {
    const { status, error } = await patchError(
      fixture,
      { subsidiaryId: null },
      new Set([fixture.rootSubsidiaryId]),
    );
    assert.equal(status, 422);
    assert.match(error, /clearing the order subsidiary is not available with restricted subsidiary scope/);
  } finally {
    gateState.authz = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});
