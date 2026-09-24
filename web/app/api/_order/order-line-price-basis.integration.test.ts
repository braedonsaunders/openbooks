import { documentRevisionCounterSql } from '@openbooks/engine/src/records/revision.ts';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression (Sol residual): a priced line kept only its unit
// price, so replay re-resolved from live configuration — revoke the
// assignment at 11am and a 10am line replayed to the base price while its
// audit still claimed Gold. document_lines.price_basis records the
// provenance the resolver returned at pricing time; replay reads the
// recorded basis, never a re-resolution, and the referenced rows still
// exist because revocations keep them.

const stateKey = Symbol.for("openbooks.order-line-price-basis-test");
interface GateState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const gateState: GateState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = gateState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.order-line-price-basis-test')]
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
      return { url: "mock:order-line-price-basis-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:order-line-price-basis-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { makePATCH } = await import("./handlers.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;
const PATCH = makePATCH({ kind: "quote", readPerm: "ar.read", createPerm: "ar.create" });

interface Fixture {
  orgId: string;
  actorId: string;
  orderId: string;
  customerId: string;
  itemId: string;
  goldId: string;
  assignmentId: string;
  goldScheduleId: string;
}

async function seedPricedQuote(tag: string): Promise<Fixture> {
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
        ${org.subsidiaryId}, 'CAD', 'draft', 0, 0, 0, 'Priced lineage'
      )
    `);
    await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
      values (${org.orgId}, ${org.customerId}, true)`);
    const goldId = randomUUID();
    await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
      values (${goldId}, ${org.orgId}, 'GOLDB', 'Gold price', 'explicit', false, true)`);
    const baseId = (await db.execute<{ id: string }>(sql`
      select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id;
    const today = new Date().toISOString().slice(0, 10);
    await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
      values (${org.orgId}, ${org.customerId}, ${goldId}, ${today}, true)`);
    const goldSchedule = randomUUID();
    const baseSchedule = randomUUID();
    await db.execute(sql`insert into item_price_schedules
        (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
      values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
             (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`);
    for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
      await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
        values (${org.orgId}, ${schedule}, '1', ${price})`);
    }
    const assignmentId = (await db.execute<{ id: string }>(sql`
      select id from customer_price_level_assignments
       where org_id = ${org.orgId} and customer_id = ${org.customerId}`)).rows[0]!.id;
    return {
      orgId: org.orgId, actorId, orderId, customerId: org.customerId,
      itemId: org.items.service, goldId, assignmentId, goldScheduleId: goldSchedule,
    };
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
  "a line priced before the revoke replays from its basis after it",
  { skip: !DB },
  async () => {
    const fixture = await seedPricedQuote("Q-BASIS-1");
    try {
      // Priced while Gold is offered: the drawer echoes the preview basis
      // (kind, schedule/level/assignment ids, price, instant — the shape the
      // price preview returns, locked by the preview route test).
      const basis = {
        kind: 'customer_level',
        scheduleId: fixture.goldScheduleId,
        levelId: fixture.goldId,
        assignmentId: fixture.assignmentId,
        unitPrice: '100.0000',
        resolvedAt: new Date().toISOString(),
      };
      const saved = await patchLines(fixture, [
        { itemId: fixture.itemId, quantity: "1", unitPrice: '100.0000', priceBasis: basis },
      ]);
      assert.equal(saved.status, 200);

      // The 11am revoke keeps the row and ends pricing from its instant —
      // the priced line is untouched.
      await withBypassContext(async () => {
        await db.execute(sql`update customer_price_level_assignments set is_active = false
         where org_id = ${fixture.orgId} and customer_id = ${fixture.customerId}`);
      });

      // Replay reads the recorded basis: still Gold at 100, pointing at the
      // assignment row that still exists.
      const line = await withOrgContext(fixture.orgId, async () => (await db.execute<{
        unit_price: string; price_basis: {
          kind: string; scheduleId: string | null; levelId: string | null;
          assignmentId: string | null; unitPrice: string; resolvedAt: string;
        } | null;
      }>(sql`
        select unit_price::text, price_basis from document_lines
         where document_id = ${fixture.orderId}`)).rows[0]!);
      assert.equal(line.unit_price, '100.00000000');
      assert.equal(line.price_basis?.kind, 'customer_level');
      assert.equal(line.price_basis?.unitPrice, '100');
      assert.equal(line.price_basis?.assignmentId, fixture.assignmentId);
      assert.equal(line.price_basis?.levelId, fixture.goldId);
      assert.equal(line.price_basis?.scheduleId, fixture.goldScheduleId);
      const assignmentAlive = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from customer_price_level_assignments
         where org_id = ${fixture.orgId} and id = ${fixture.assignmentId}`)).rows[0]!.n);
      assert.equal(assignmentAlive, 1);
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "a basis for a different price refuses instead of persisting",
  { skip: !DB },
  async () => {
    const fixture = await seedPricedQuote("Q-BASIS-2");
    try {
      // Stale lineage: the basis says 100 but the line says 90.
      const res = await patchLines(fixture, [
        {
          itemId: fixture.itemId, quantity: "1", unitPrice: "90",
          priceBasis: {
            kind: 'customer_level', scheduleId: fixture.goldScheduleId, levelId: fixture.goldId,
            assignmentId: fixture.assignmentId, unitPrice: '100.0000', resolvedAt: new Date().toISOString(),
          },
        },
      ]);
      assert.equal(res.status, 400);
    } finally {
      gateState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);
