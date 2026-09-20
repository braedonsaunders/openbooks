import { documentRevisionCounterSql } from '@openbooks/engine/src/records/revision.ts';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: document_lines.unit_price is numeric(28,8), so a
// saved order line reads back at storage scale ('200.00000000'). The shared
// order PATCH (quote / sales_order / purchase_order via
// web/app/api/_order/handlers.ts) validated unitPrice with the 4dp ledger
// helper, so re-saving the stored values — exactly what the OrderDrawer sends
// on every reload-then-save or reload-then-issue — failed with a 422
// ('Order lines contain an invalid quantity or amount') instead of round-
// tripping. Input validation must accept the column's own scale.

const stateKey = Symbol.for("openbooks.order-line-scale-test");
interface GateState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const gateState: GateState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = gateState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.order-line-scale-test')]
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
      return { url: "mock:order-line-scale-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:order-line-scale-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { makePATCH } = await import("./handlers.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts",
);

const DB = !!process.env.OPENBOOKS_DB_URL;
const PATCH = makePATCH({ kind: "quote", readPerm: "ar.read", createPerm: "ar.create" });

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
  gateState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  // Handler calls and verification reads run in the scratch org's scope,
  // mirroring a production request.
  const revision = await withOrgContext(fixture.orgId, async () =>
    (await db.execute<{ revision: string }>(sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
        from documents where id = ${fixture.orderId}`)).rows[0]!.revision);
  return withOrgContext(fixture.orgId, () => PATCH(
    new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt: revision, lines }),
    }) as never,
    { params: Promise.resolve({ id: fixture.orderId }) } as never,
  )) as unknown as Response;
}

test(
  "order PATCH round-trips a stored 8dp unit price",
  { skip: !DB },
  async () => {
    const fixture = await seedDraftQuote("Q-SCALE-1");
    try {
      const first = await patchLines(fixture, [
        { accountId: fixture.revenueId, quantity: "2", unitPrice: "200.00" },
      ]);
      assert.equal(first.status, 200);
      const stored = await withOrgContext(fixture.orgId, async () =>
        (await db.execute<{ quantity: string; unit_price: string }>(sql`
          select quantity::text, unit_price::text from document_lines
           where document_id = ${fixture.orderId}`)).rows[0]!);
      // Premise: storage pads to the column scale.
      assert.equal(stored.unit_price, "200.00000000");
      // The drawer sends back exactly what it read; that must save.
      const second = await patchLines(fixture, [
        { accountId: fixture.revenueId, quantity: stored.quantity, unitPrice: stored.unit_price },
      ]);
      assert.equal(second.status, 200);
      const body = (await second.json()) as { doc: { subtotal: string; tax_total: string; total: string } };
      assert.equal(body.doc.subtotal, "400.0000");
      assert.equal(body.doc.tax_total, "0.0000");
      assert.equal(body.doc.total, "400.0000");
    } finally {
      await dropScratchOrg(fixture.orgId);
    }
  },
);
