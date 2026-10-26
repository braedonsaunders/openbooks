import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";
import { sql } from "drizzle-orm";

// Live-Postgres regression: document_lines.unit_price is numeric(28,8), so a
// saved order line reads back at storage scale ('200.00000000'). The shared
// order PATCH (quote / sales_order / purchase_order via
// web/app/api/_order/handlers.ts) validated unitPrice with the 4dp ledger
// helper, so re-saving the stored values — exactly what the OrderDrawer sends
// on every reload-then-save or reload-then-issue — failed with a 422
// ('Order lines contain an invalid quantity or amount') instead of round-
// tripping. Input validation must accept the column's own scale.

// The real route resolves the caller from the session exactly as in
// production: the test supplies only the signed-in identity, and the user's
// roles grant its permissions and subsidiary scope.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __orderLineScaleSession: session });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__orderLineScaleSession.user}",
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
  revenueId: string;
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
        ${org.subsidiaryId}, 'CAD', 'draft', 0, 0, 0, 'Line-scale terms'
      )
    `);
    return { orgId: org.orgId, actorId, orderId, revenueId: org.accounts.revenue };
  });
}

async function patchLines(
  fixture: Fixture,
  lines: Array<Record<string, unknown>>,
): Promise<Response> {
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
  return withOrgContext(fixture.orgId, () =>
    PATCH(
      new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: revision, lines }),
      }) as never,
      { params: Promise.resolve({ id: fixture.orderId }) } as never,
    ),
  ) as unknown as Response;
}

test("order PATCH round-trips a stored 8dp unit price", async () => {
  const fixture = await seedDraftQuote("Q-SCALE-1");
  try {
    const first = await patchLines(fixture, [
      { accountId: fixture.revenueId, quantity: "2", unitPrice: "200.00" },
    ]);
    assert.equal(first.status, 200);
    const stored = await withOrgContext(
      fixture.orgId,
      async () =>
        (
          await db.execute<{ quantity: string; unit_price: string }>(
            sql`
          select quantity::text, unit_price::text from document_lines
           where document_id = ${fixture.orderId}`,
            "objects",
          )
        )[0]!,
    );
    // Premise: storage pads to the column scale.
    assert.equal(stored.unit_price, "200.00000000");
    // The drawer sends back exactly what it read; that must save.
    const second = await patchLines(fixture, [
      { accountId: fixture.revenueId, quantity: stored.quantity, unitPrice: stored.unit_price },
    ]);
    assert.equal(second.status, 200);
    const body = (await second.json()) as {
      doc: { subtotal: string; tax_total: string; total: string };
    };
    assert.equal(body.doc.subtotal, "400.0000");
    assert.equal(body.doc.tax_total, "0.0000");
    assert.equal(body.doc.total, "400.0000");
  } finally {
    await dropScratchOrg(fixture.orgId);
  }
});
