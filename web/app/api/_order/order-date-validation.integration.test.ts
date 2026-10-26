import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";
import { sql } from "drizzle-orm";

// Live-Postgres regression: the shared order PATCH (quote / sales_order /
// purchase_order via web/app/api/_order/handlers.ts) coalesced
// body.documentDate / body.dueDate into DATE columns with no calendar
// validation, so an impossible date (2026-02-30) tripped a raw storage
// 22008 failure (HTTP 500) instead of a domain 422. The route must validate
// both dates with the shared ISO calendar helper before writing.

// The real route resolves the caller from the session exactly as in
// production: the test supplies only the signed-in identity, and the user's
// roles grant its permissions and subsidiary scope.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __orderDateValidationSession: session });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__orderDateValidationSession.user}",
      };
    }
    return nextResolve(specifier, context);
  },
});

function signIn(orgId: string, userId: string): void {
  session.user = {
    id: userId,
    orgId,
    name: "Order editor",
    email: "order-editor@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

const { PATCH } = await import("../estimates/[id]/route.ts");

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");

interface Fixture {
  orgId: string;
  actorId: string;
  orderId: string;
}

async function seedDraftQuote(tag: string): Promise<Fixture> {
  // Fixture seeds under explicit bypass: the top-level ./handlers.ts import
  // pulls in the web request-org resolver, which denies every unscoped query.
  return withBypassContext(async () => {
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
  });
}

async function patchRequest(fixture: Fixture, body: Record<string, unknown>): Promise<Request> {
  signIn(fixture.orgId, fixture.actorId);
  // Handler calls and verification reads run in the scratch org's scope,
  // mirroring a production request.
  const revision = await withOrgContext(
    fixture.orgId,
    async () =>
      (
        await db.execute<{ revision: string }>(
          sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
        from documents where id = ${fixture.orderId}`,
          "objects",
        )
      )[0]!.revision,
  );
  return new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: revision, ...body }),
  });
}

test("order PATCH refuses an impossible documentDate with a domain error", async () => {
  const fixture = await seedDraftQuote("Q-DATE-1");
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await patchRequest(fixture, { documentDate: "2026-02-30" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(response.status, 422, `impossible documentDate must be a 422: ${response.status}`);
    const state = await withOrgContext(
      fixture.orgId,
      async () =>
        await db.execute<{ document_date: string }>(
          sql`
        select document_date::text as document_date from documents where id = ${fixture.orderId}`,
          "objects",
        ),
    );
    assert.notEqual(state[0]?.document_date, "2026-02-30");
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("order PATCH refuses an impossible dueDate with a domain error", async () => {
  const fixture = await seedDraftQuote("Q-DATE-2");
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await patchRequest(fixture, { dueDate: "2026-02-30" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(response.status, 422, `impossible dueDate must be a 422: ${response.status}`);
    const state = await withOrgContext(
      fixture.orgId,
      async () =>
        await db.execute<{ due_date: string | null }>(
          sql`
        select due_date::text as due_date from documents where id = ${fixture.orderId}`,
          "objects",
        ),
    );
    assert.equal(state[0]?.due_date, null);
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("order PATCH still saves a valid calendar date", async () => {
  const fixture = await seedDraftQuote("Q-DATE-3");
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await patchRequest(fixture, { documentDate: "2026-07-20", memo: "Dated terms" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(
      response.status,
      200,
      `valid save failed: ${JSON.stringify(await response.json())}`,
    );
    const state = await withOrgContext(
      fixture.orgId,
      async () =>
        await db.execute<{ document_date: string; memo: string }>(
          sql`
        select document_date::text as document_date, memo from documents where id = ${fixture.orderId}`,
          "objects",
        ),
    );
    assert.equal(state[0]?.document_date, "2026-07-20");
    assert.equal(state[0]?.memo, "Dated terms");
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

async function seedDraftQuoteWithLine(tag: string) {
  const fixture = await seedDraftQuote(tag);
  return withBypassContext(async () => {
    const account = (
      await db.execute<{ id: string }>(
        sql`
      select id from accounts where org_id = ${fixture.orgId} order by number limit 1`,
        "objects",
      )
    )[0]!.id;
    await db.execute(sql`
      insert into document_lines(org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
      values (${fixture.orgId}, ${fixture.orderId}, 1, ${account}, 'Seeded line', 1, 100, 100)
    `);
    await db.execute(sql`
      update documents set subtotal = 100, tax_total = 0, total = 100
       where id = ${fixture.orderId} and org_id = ${fixture.orgId}`);
    return fixture;
  });
}

async function orderState(fixture: Fixture) {
  return withOrgContext(
    fixture.orgId,
    async () =>
      (
        await db.execute<{ lines: number; total: string; party: string | null }>(
          sql`
      select (select count(*)::int from document_lines
               where org_id = ${fixture.orgId} and document_id = ${fixture.orderId}) as lines,
             (select total::text from documents
               where org_id = ${fixture.orgId} and id = ${fixture.orderId}) as total,
             (select party_id::text from documents
               where org_id = ${fixture.orgId} and id = ${fixture.orderId}) as party`,
          "objects",
        )
      )[0]!,
  );
}

test("order PATCH refuses a non-array lines payload without touching the order", async () => {
  const fixture = await seedDraftQuoteWithLine("Q-SHAPE-1");
  const before = await orderState(fixture);
  assert.equal(before.lines, 1);
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await patchRequest(fixture, { lines: "corrupt" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(response.status, 422, `non-array lines must be a 422: ${response.status}`);
    assert.deepEqual(
      await orderState(fixture),
      before,
      "the refused save must leave lines and totals intact",
    );
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("order PATCH refuses a null line entry without touching the order", async () => {
  const fixture = await seedDraftQuoteWithLine("Q-SHAPE-2");
  const before = await orderState(fixture);
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await patchRequest(fixture, { lines: [null] }), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(response.status, 422, `null line entry must be a 422: ${response.status}`);
    assert.deepEqual(
      await orderState(fixture),
      before,
      "the refused save must leave lines and totals intact",
    );
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("order PATCH refuses a malformed party reference without touching the order", async () => {
  const fixture = await seedDraftQuoteWithLine("Q-SHAPE-3");
  const before = await orderState(fixture);
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await patchRequest(fixture, { partyId: "not-a-uuid" }), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(response.status, 422, `malformed partyId must be a 422: ${response.status}`);
    assert.deepEqual(
      await orderState(fixture),
      before,
      "the refused save must leave the order intact",
    );
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("order PATCH refuses another organization's party with a domain error", async () => {
  const fixture = await seedDraftQuoteWithLine("Q-ALIEN-1");
  const foreign = await withBypassContext(() => createScratchOrg());
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(await patchRequest(fixture, { partyId: foreign.customerId }), {
        params: Promise.resolve({ id: fixture.orderId }),
      }),
    );
    assert.equal(response.status, 422, `alien partyId must be a 422: ${response.status}`);
    const state = await withOrgContext(
      fixture.orgId,
      async () =>
        await db.execute<{ party: string }>(
          sql`
        select party_id::text as party from documents
         where org_id = ${fixture.orgId} and id = ${fixture.orderId}`,
          "objects",
        ),
    );
    assert.notEqual(state[0]?.party, foreign.customerId);
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
    await dropScratchOrg(foreign.orgId);
  }
});

test("order PATCH refuses another organization's account on a line with a domain error", async () => {
  const fixture = await seedDraftQuote("Q-ALIEN-2");
  const foreign = await withBypassContext(() => createScratchOrg());
  const before = await orderState(fixture);
  try {
    const response = await withOrgContext(fixture.orgId, async () =>
      PATCH(
        await patchRequest(fixture, {
          lines: [
            {
              accountId: foreign.accounts.revenue,
              description: "Alien line",
              quantity: "1",
              unitPrice: "10",
            },
          ],
        }),
        { params: Promise.resolve({ id: fixture.orderId }) },
      ),
    );
    assert.equal(response.status, 422, `alien accountId must be a 422: ${response.status}`);
    assert.deepEqual(
      await orderState(fixture),
      before,
      "the refused save must leave lines and totals intact",
    );
  } finally {
    session.user = null;
    await dropScratchOrg(fixture.orgId);
    await dropScratchOrg(foreign.orgId);
  }
});
