import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: saving a rate card whose payload carries MULTIPLE
// items / customers / kept lines must round-trip. The save path validates its
// id collections with `= any(<collection>::uuid[])`; a plain JS array bound
// into a drizzle sql template serializes as a row constructor `( $1, $2 )`
// which PostgreSQL rejects (`cannot cast type record to uuid[]`) once it holds
// more than one element — a single element can mask the bug, so every
// collection exercised here is deliberately multi-element.
const stateKey = Symbol.for("openbooks.lrc-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.lrc-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("labor-rate-cards")) {
      return { url: "mock:authz", shortCircuit: true };
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

const routeUrl = "./route.ts?lrc-array-binding-test";
const { PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

interface Fixture {
  orgId: string;
  actorId: string;
  versionId: string;
  bookId: string;
  storedLineIds: string[];
  lineItems: string[];
  locations: [string, string];
  customers: [string, string];
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({
        projects: true,
        multiCurrency: true,
        inventory: true,
      })}::jsonb)
     where id = ${org.orgId}`);

  const bookId = randomUUID();
  await db.execute(sql`
    insert into item_rate_books (org_id, id, code, name, currency, is_default, is_active, created_by, updated_by)
    values (${org.orgId}, ${bookId}, 'FIELD', 'Field Rates', 'CAD', false, true, ${actorId}, ${actorId})`);
  const versionId = randomUUID();
  await db.execute(sql`
    insert into item_rate_versions (org_id, id, rate_book_id, effective_from, status, custom, created_by, updated_by)
    values (${org.orgId}, ${versionId}, ${bookId}, '2026-07-01', 'draft', '{}'::jsonb, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_rate_version_policies (org_id, version_id, derivation_policy, created_by, updated_by)
    values (${org.orgId}, ${versionId}, 'explicit', ${actorId}, ${actorId})`);

  const storedLineIds: string[] = [];
  const lineItems = [org.items.fifo, org.items.movingAvg, org.items.standard];
  for (const [sortOrder, itemId] of lineItems.entries()) {
    const lineId = randomUUID();
    storedLineIds.push(lineId);
    await db.execute(sql`
      insert into item_rate_lines (org_id, id, version_id, item_id, unit_code, unit_name, base_quantity, bill_rate,
                                   time_type_bill_rates, sort_order, created_by, updated_by)
      values (${org.orgId}, ${lineId}, ${versionId}, ${itemId}, 'hour', 'Hour', 1, '100.00', '{}'::jsonb,
              ${sortOrder}, ${actorId}, ${actorId})`);
  }

  // createScratchOrg seeds two active locations but returns only the first.
  const locationRows = (await db.execute<{ id: string }>(sql`
    select id from locations where org_id = ${org.orgId} and is_active order by name`));
  assert.equal(locationRows.rows.length >= 2, true, "scratch org seeds two locations");

  const customers: string[] = [];
  for (const name of ["Customer One", "Customer Two"]) {
    const partyId = randomUUID();
    customers.push(partyId);
    await db.execute(sql`
      insert into parties (org_id, id, kind, display_name, is_active, custom)
      values (${org.orgId}, ${partyId}, 'customer', ${name}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into customer_roles (org_id, party_id, is_active)
      values (${org.orgId}, ${partyId}, true)`);
  }

  return {
    orgId: org.orgId,
    actorId,
    versionId,
    bookId,
    storedLineIds,
    lineItems,
    locations: [locationRows.rows[0]!.id, locationRows.rows[1]!.id],
    customers: customers as [string, string],
  };
}

function putBody(fixture: Fixture, keepLineIds?: string[], status = "draft") {
  const { storedLineIds, lineItems, locations, customers } = fixture;
  const kept = keepLineIds ?? storedLineIds;
  const itemByLine = new Map<string, string>();
  storedLineIds.forEach((lineId, i) => itemByLine.set(lineId, lineItems[i]!));
  return {
    name: "Field Crew Rates",
    code: "FIELD2",
    effective_from: "2026-07-01",
    status,
    derivation_policy: "explicit",
    scopes: [
      { scopeType: "location", scopeValueId: locations[0], includeChildren: true },
      { scopeType: "location", scopeValueId: locations[1], includeChildren: false },
    ],
    lines: kept.map((lineId) => ({
      id: lineId,
      itemId: itemByLine.get(lineId),
      regular: "125.50",
    })),
    adjustments: [
      {
        code: "Markup",
        name: "Overhead markup",
        category: "markup",
        calculation: "percent",
        value: "10",
        presentation: "separate",
        targets: lineItems.map((itemId) => ({ targetType: "item", targetValueId: itemId })),
      },
      {
        code: "rush",
        name: "Rush surcharge",
        category: "surcharge",
        calculation: "fixed",
        value: "50",
        unit: "flat",
        presentation: "separate",
        targets: customers.map((customerId) => ({ targetType: "customer", targetValueId: customerId })),
      },
    ],
    terms: [
      {
        code: "net30",
        label: "Net 30",
        content: "Payment due within thirty days of invoice.",
        placement: "conditions",
      },
    ],
  };
}

function put(fixture: Fixture, body: Record<string, unknown>): Promise<Response> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return PUT(new Request(`http://openbooks.test/api/labor-rate-cards/${fixture.versionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: fixture.versionId }) });
}

test(
  "PUT saves multi-element item/customer/location/line collections against live Postgres",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypass(seed);
    try {
      // Activating from the editor is the deepest legal save: children must
      // be rewritten while the stored status is still draft.
      const response = await withOrgContext(fixture.orgId, () =>
        put(fixture, putBody(fixture, undefined, "active")));
      const payload = (await response.json()) as { ok?: boolean; id?: string; errorCode?: string };
      assert.equal(response.status, 200, `save failed: ${JSON.stringify(payload)}`);
      assert.deepEqual(payload, { ok: true, id: fixture.versionId });

      await withOrgContext(fixture.orgId, async () => {
        const book = (await db.execute<{ name: string; code: string }>(sql`
          select name, code from item_rate_books where id = ${fixture.bookId}`));
        assert.deepEqual(book.rows[0], { name: "Field Crew Rates", code: "FIELD2" });

        const version = (await db.execute<{ status: string }>(sql`
          select status from item_rate_versions where id = ${fixture.versionId}`));
        assert.equal(version.rows[0]?.status, "active");

        // All three re-sent stored lines survive the not(id = any(...)) prune,
        // re-pointed at their items with fresh rates in payload order.
        const lines = (await db.execute<{ id: string; billRate: string | null; sortOrder: number }>(sql`
          select id, bill_rate::text as "billRate", sort_order as "sortOrder"
            from item_rate_lines
           where version_id = ${fixture.versionId}
           order by sort_order`));
        assert.deepEqual(lines.rows.map((row) => row.id), fixture.storedLineIds);
        for (const row of lines.rows) assert.equal(row.billRate, "125.5000");

        const adjustments = (await db.execute<{ code: string; n_targets: number }>(sql`
          select a.code, count(at.id)::int as "nTargets"
            from labor_rate_adjustments a
            left join labor_rate_adjustment_targets at on at.adjustment_id = a.id and at.org_id = a.org_id
           where a.version_id = ${fixture.versionId} and a.org_id = ${fixture.orgId}
           group by a.code order by a.code`));
        assert.deepEqual(adjustments.rows, [
          { code: "markup", nTargets: 3 },
          { code: "rush", nTargets: 2 },
        ]);

        const scopes = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from labor_rate_version_scopes
           where version_id = ${fixture.versionId} and org_id = ${fixture.orgId}`));
        assert.equal(scopes.rows[0]?.n, 2);

        const terms = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from labor_rate_terms
           where version_id = ${fixture.versionId} and org_id = ${fixture.orgId}`));
        assert.equal(terms.rows[0]?.n, 1);

        const audit = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from audit_log
           where org_id = ${fixture.orgId} and table_name = 'item_rate_versions'
             and row_id = ${fixture.versionId} and action = 'update'`));
        assert.equal(audit.rows[0]?.n, 1);
      });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "PUT prunes exactly the kept-line complement via not(id = any(multi-element))",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypass(seed);
    try {
      const first = await withOrgContext(fixture.orgId, () => put(fixture, putBody(fixture)));
      assert.equal(first.status, 200, `initial save failed: ${JSON.stringify(await first.json())}`);

      // Re-send only two of the three stored lines: the third is the
      // complement of a multi-element any() list and must be deleted alone.
      const keepTwo = fixture.storedLineIds.slice(0, 2);
      const second = await withOrgContext(fixture.orgId, () => put(fixture, putBody(fixture, keepTwo)));
      assert.equal(second.status, 200, `prune save failed: ${JSON.stringify(await second.json())}`);

      await withOrgContext(fixture.orgId, async () => {
        const remaining = (await db.execute<{ id: string }>(sql`
          select id from item_rate_lines
           where version_id = ${fixture.versionId} and org_id = ${fixture.orgId}
           order by sort_order`));
        assert.deepEqual(remaining.rows.map((row) => row.id), keepTwo);
      });
    } finally {
      await withBypass(() => dropScratchOrg(fixture.orgId));
    }
  },
);
