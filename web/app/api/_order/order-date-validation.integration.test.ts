import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: the shared order PATCH (quote / sales_order /
// purchase_order via web/app/api/_order/handlers.ts) coalesced
// body.documentDate / body.dueDate into DATE columns with no calendar
// validation, so an impossible date (2026-02-30) tripped a raw storage
// 22008 failure (HTTP 500) instead of a domain 422. The route must validate
// both dates with the shared ISO calendar helper before writing.

const stateKey = Symbol.for("openbooks.order-date-test");
interface GateState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const gateState: GateState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = gateState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.order-date-test')]
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
      return { url: "mock:order-date-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:order-date-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { makePATCH } = await import("./handlers.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts",
);

const DB = !!process.env.OPENBOOKS_DB_URL;
const PATCH = makePATCH({ kind: "quote", readPerm: "ar.read", createPerm: "ar.create" });

interface Fixture {
  orgId: string;
  actorId: string;
  orderId: string;
}

async function seedDraftQuote(tag: string): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const orderId = randomUUID();
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, document_date, party_id, subsidiary_id,
      currency, status, subtotal, tax_total, total, memo
    ) values (
      ${orderId}, ${org.orgId}, 'quote', ${tag}, ${org.date}, ${org.customerId},
      ${org.subsidiaryId}, 'CAD', 'draft', 0, 0, 0, 'Date-validation terms'
    )
  `);
  return { orgId: org.orgId, actorId, orderId };
}

async function patchRequest(fixture: Fixture, body: Record<string, unknown>): Promise<Request> {
  gateState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  const revision = (await db.execute<{ revision: string }>(sql`
    select ${documentRevisionSql(sql`updated_at`)} as revision
      from documents where id = ${fixture.orderId}`)).rows[0]!.revision;
  return new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: revision, ...body }),
  });
}

test(
  "order PATCH refuses an impossible documentDate with a domain error",
  { skip: !DB },
  async () => {
    const fixture = await seedDraftQuote("Q-DATE-1");
    try {
      const response = await PATCH(await patchRequest(fixture, { documentDate: "2026-02-30" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      });
      assert.equal(response.status, 422, `impossible documentDate must be a 422: ${response.status}`);
      const state = await db.execute<{ document_date: string }>(sql`
        select document_date::text as document_date from documents where id = ${fixture.orderId}`);
      assert.notEqual(state.rows[0]?.document_date, "2026-02-30");
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "order PATCH refuses an impossible dueDate with a domain error",
  { skip: !DB },
  async () => {
    const fixture = await seedDraftQuote("Q-DATE-2");
    try {
      const response = await PATCH(await patchRequest(fixture, { dueDate: "2026-02-30" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      });
      assert.equal(response.status, 422, `impossible dueDate must be a 422: ${response.status}`);
      const state = await db.execute<{ due_date: string | null }>(sql`
        select due_date::text as due_date from documents where id = ${fixture.orderId}`);
      assert.equal(state.rows[0]?.due_date, null);
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "order PATCH still saves a valid calendar date",
  { skip: !DB },
  async () => {
    const fixture = await seedDraftQuote("Q-DATE-3");
    try {
      const response = await PATCH(
        await patchRequest(fixture, { documentDate: "2026-07-20", memo: "Dated terms" }),
        { params: Promise.resolve({ id: fixture.orderId }) },
      );
      assert.equal(response.status, 200, `valid save failed: ${JSON.stringify(await response.json())}`);
      const state = await db.execute<{ document_date: string; memo: string }>(sql`
        select document_date::text as document_date, memo from documents where id = ${fixture.orderId}`);
      assert.equal(state.rows[0]?.document_date, "2026-07-20");
      assert.equal(state.rows[0]?.memo, "Dated terms");
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

async function seedDraftQuoteWithLine(tag: string) {
  const fixture = await seedDraftQuote(tag);
  const account = (await db.execute<{ id: string }>(sql`
    select id from accounts where org_id = ${fixture.orgId} order by number limit 1`)).rows[0]!.id;
  await db.execute(sql`
    insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
    values (${fixture.orgId}, ${fixture.orderId}, 1, ${account}, 'Seeded line', 1, 100, 100)
  `);
  await db.execute(sql`
    update documents set subtotal = 100, tax_total = 0, total = 100
     where id = ${fixture.orderId} and org_id = ${fixture.orgId}`);
  return fixture;
}

async function orderState(fixture: Fixture) {
  return (await db.execute<{ lines: number; total: string; party: string | null }>(sql`
    select (select count(*)::int from document_lines
             where org_id = ${fixture.orgId} and document_id = ${fixture.orderId}) as lines,
           (select total::text from documents
             where org_id = ${fixture.orgId} and id = ${fixture.orderId}) as total,
           (select party_id::text from documents
             where org_id = ${fixture.orgId} and id = ${fixture.orderId}) as party`)).rows[0]!;
}

test(
  "order PATCH refuses a non-array lines payload without touching the order",
  { skip: !DB },
  async () => {
    const fixture = await seedDraftQuoteWithLine("Q-SHAPE-1");
    const before = await orderState(fixture);
    assert.equal(before.lines, 1);
    try {
      const response = await PATCH(await patchRequest(fixture, { lines: "corrupt" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      });
      assert.equal(response.status, 422, `non-array lines must be a 422: ${response.status}`);
      assert.deepEqual(await orderState(fixture), before, "the refused save must leave lines and totals intact");
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "order PATCH refuses a null line entry without touching the order",
  { skip: !DB },
  async () => {
    const fixture = await seedDraftQuoteWithLine("Q-SHAPE-2");
    const before = await orderState(fixture);
    try {
      const response = await PATCH(await patchRequest(fixture, { lines: [null] }), {
        params: Promise.resolve({ id: fixture.orderId }),
      });
      assert.equal(response.status, 422, `null line entry must be a 422: ${response.status}`);
      assert.deepEqual(await orderState(fixture), before, "the refused save must leave lines and totals intact");
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "order PATCH refuses a malformed party reference without touching the order",
  { skip: !DB },
  async () => {
    const fixture = await seedDraftQuoteWithLine("Q-SHAPE-3");
    const before = await orderState(fixture);
    try {
      const response = await PATCH(await patchRequest(fixture, { partyId: "not-a-uuid" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      });
      assert.equal(response.status, 422, `malformed partyId must be a 422: ${response.status}`);
      assert.deepEqual(await orderState(fixture), before, "the refused save must leave the order intact");
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);
