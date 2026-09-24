import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The price preview is the drawer's pricing-time source: its response must
// carry the full lineage the drawer echoes as the line's recorded basis
// (kind, schedule/level/assignment ids, resolved instant). After a same-day
// revoke the same request falls to the base price — while a line that
// recorded the earlier basis keeps it (see the order-line basis test).

const stateKey = Symbol.for("openbooks.items-price-basis-test");
interface GateState {
  authz: {
    user: { orgId: string; id: string };
  } | null;
}
const gateState: GateState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = gateState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.items-price-basis-test')]
  export async function guardPermission(_permission) {
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
      if (specifier === "@/lib/authz" && context.parentURL.includes("/api/items/price")) {
        return { url: "mock:items-price-basis-authz", shortCircuit: true };
      }
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:items-price-basis-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?items-price-basis-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  customerId: string;
  itemId: string;
  goldId: string;
  assignmentId: string;
  goldScheduleId: string;
}

async function seedPricing(): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const customerId = randomUUID();
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
      values (${org.orgId}, ${customerId}, true)`);
    const goldId = randomUUID();
    await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
      values (${goldId}, ${org.orgId}, 'GOLDP', 'Gold price', 'explicit', false, true)`);
    const baseId = (await db.execute<{ id: string }>(sql`
      select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id;
    const today = new Date().toISOString().slice(0, 10);
    await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
      values (${org.orgId}, ${customerId}, ${goldId}, ${today}, true)`);
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
       where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!.id;
    return {
      orgId: org.orgId, actorId: "00000000-0000-0000-0000-000000000000",
      customerId, itemId: org.items.service, goldId, assignmentId, goldScheduleId: goldSchedule,
    };
  });
}

async function preview(fixture: Fixture, onDate: string) {
  gateState.authz = { user: { orgId: fixture.orgId, id: fixture.actorId } };
  try {
    // The route reads through RLS like production: run it inside the org
    // context, the same wrapper the order-line basis test uses.
    const res = await withOrgContext(fixture.orgId, () => POST(new Request("http://localhost/api/items/price", {
      method: "POST",
      body: JSON.stringify({
        itemId: fixture.itemId, customerId: fixture.customerId,
        currency: "CAD", onDate, lineQuantity: "1",
      }),
    })));
    assert.equal(res.status, 200);
    return (await res.json()) as { price: {
      unitPrice: string; source: string; scheduleId: string | null;
      priceLevelId: string | null; priceLevelName: string | null;
      assignmentId: string | null; resolvedAt: string;
    } | null };
  } finally {
    gateState.authz = null;
  }
}

test(
  "the preview carries price lineage, and falls to base after the revoke",
  { skip: !DB },
  async () => {
    const fixture = await seedPricing();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const before = await preview(fixture, today);
      assert.equal(before.price?.unitPrice, '100.0000');
      assert.equal(before.price?.source, 'customer_level');
      assert.equal(before.price?.scheduleId, fixture.goldScheduleId);
      assert.equal(before.price?.priceLevelId, fixture.goldId);
      assert.equal(before.price?.assignmentId, fixture.assignmentId);
      assert.ok(before.price?.resolvedAt);

      await withBypassContext(async () => {
        await db.execute(sql`update customer_price_level_assignments set is_active = false
         where org_id = ${fixture.orgId} and customer_id = ${fixture.customerId}`);
      });

      const after = await preview(fixture, today);
      assert.equal(after.price?.unitPrice, '80.0000');
      assert.equal(after.price?.source, 'base_level');
    } finally {
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "a deactivated level ends pricing from its close with the event instant recorded",
  { skip: !DB },
  async () => {
    const fixture = await seedPricing();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const before = await preview(fixture, today);
      assert.equal(before.price?.unitPrice, '100.0000');
      assert.equal(before.price?.source, 'customer_level');

      // Guard-compliant shutdown: assignment and schedule go quiet first,
      // then the level itself closes.
      await withBypassContext(async () => {
        await db.execute(sql`update customer_price_level_assignments set is_active = false
         where org_id = ${fixture.orgId} and customer_id = ${fixture.customerId}`);
        await db.execute(sql`update item_price_schedules set is_active = false
         where org_id = ${fixture.orgId} and price_level_id = ${fixture.goldId}`);
        await db.execute(sql`update price_levels set is_active = false
         where org_id = ${fixture.orgId} and id = ${fixture.goldId}`);
      });

      const period = await withBypassContext(async () => (await db.execute<{
        active_to: string | null; closed: boolean;
      }>(sql`
        select active_to::text as active_to, (closed_at is not null) as closed
          from price_level_activation_history
         where org_id = ${fixture.orgId} and price_level_id = ${fixture.goldId}
         order by active_from desc limit 1`)).rows[0]!);
      assert.equal(period.active_to, today);
      assert.equal(period.closed, true);

      const after = await preview(fixture, today);
      assert.equal(after.price?.unitPrice, '80.0000');
      assert.equal(after.price?.source, 'base_level');
    } finally {
      await dropScratchOrg(fixture.orgId);
    }
  },
);
