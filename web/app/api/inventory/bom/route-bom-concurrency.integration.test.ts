import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

// Bill of materials replacement races (web/app/api/inventory/bom/route.ts).
// ROW EXCLUSIVE table locks do not conflict with each other, so two PUTs on
// an empty BOM used to both read version null and union into a recipe nobody
// wrote; and the feature gate was a pre-transaction read, so a disable racing
// the save still replaced the recipe. Only the session gate is mocked — the
// database, the version check, and the feature fence are all real.
const stateKey = Symbol.for("openbooks.bom-route-concurrency-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
const responseKey = Symbol.for("openbooks.bom-route-test-next-response");
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
// The real refusal contract, shared with the doubles below: they answer
// with actual NextResponse refusals, never plain Responses, because the
// route checks instanceof NextResponse exactly like production.
(globalThis as typeof globalThis & Record<symbol, unknown>)[responseKey] = NextResponse;

const mockFeatureGates = `
  const NextResponse = globalThis[Symbol.for('openbooks.bom-route-test-next-response')]
  const state = globalThis[Symbol.for('openbooks.bom-route-concurrency-test')]
  export async function guardFeaturePermission(permission, _featureKey) {
    if (!state.authz) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    if (!state.authz.permissions.has(permission)) return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
    return state.authz
  }
`;

const mockAuthz = `
  const NextResponse = globalThis[Symbol.for('openbooks.bom-route-test-next-response')]
  const state = globalThis[Symbol.for('openbooks.bom-route-concurrency-test')]
  export function guardUnrestrictedScope(authz) {
    if (authz.allowedSubsidiaryIds == null) return null
    return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
  }
  export function can(authz, perm) {
    return authz.permissions.has(perm)
  }
  export function guardPermission(perm) {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (!state.authz.permissions.has(perm)) return NextResponse.json({ error: 'missing permission: ' + perm }, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/feature-gates") {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    if (specifier === "@/lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?bom-route-concurrency-test";
const { GET, PUT } = (await import(routeUrl)) as typeof import("./route.ts");

const { db, pool } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);


function authenticate(orgId: string, actorId: string) {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/inventory/bom", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function recipe(assemblyItemId: string, componentItemId: string) {
  return {
    assemblyItemId,
    expectedVersion: null,
    reason: "Concurrency regression probe: replace the whole recipe.",
    components: [{ componentItemId, quantityPer: "1" }],
  };
}

async function bomRows(orgId: string, assemblyItemId: string) {
  return (await db.execute<{ componentItemId: string; quantityPer: string }>(sql`
    select component_item_id as "componentItemId", quantity_per::text as "quantityPer"
      from bom_components
     where org_id = ${orgId} and assembly_item_id = ${assemblyItemId}
     order by sort_order, component_item_id`)).rows;
}

async function bomAudits(orgId: string, assemblyItemId: string) {
  return (await db.execute<{ changes: unknown }>(sql`
    select changes from audit_log
     where org_id = ${orgId} and table_name = 'bom_components' and row_id = ${assemblyItemId}
     order by id`)).rows;
}

async function emptyBom(orgId: string, assemblyItemId: string) {
  await db.execute(sql`
    delete from bom_components where org_id = ${orgId} and assembly_item_id = ${assemblyItemId}`);
}

test.after(() => hooks.deregister())
test("two concurrent empty-BOM replacements serialize: one recipe, one 409", async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Race Admin", "admin");
    authenticate(org.orgId, actorId);
    await emptyBom(org.orgId, org.items.assembly);

    const [first, second] = await Promise.all([
      PUT(putRequest(recipe(org.items.assembly, org.items.component))),
      PUT(putRequest(recipe(org.items.assembly, org.items.fifo))),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one writer wins and the loser takes the revision conflict");

    const winner = first.status === 200 ? first : second;
    const winnerComponent = first.status === 200 ? org.items.component : org.items.fifo;
    const body = (await winner.json()) as { version: string; componentCount: number };
    assert.equal(body.componentCount, 1);
    assert.ok(typeof body.version === "string" && body.version.length > 0);

    const rows = await bomRows(org.orgId, org.items.assembly);
    assert.equal(rows.length, 1, "the final recipe is one complete recipe, never the union of both writers");
    assert.equal(rows[0]!.componentItemId, winnerComponent);

    const audits = await bomAudits(org.orgId, org.items.assembly);
    assert.equal(audits.length, 1, "exactly one replacement is audited");
    const changes = audits[0]!.changes as { before: unknown[]; after: { componentItemId: string }[] };
    assert.deepEqual(changes.before, []);
    assert.equal(changes.after.length, 1);
    assert.equal(changes.after[0]!.componentItemId, winnerComponent);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("disabled Manufacturing refuses operation and by-product fields; disabled Inventory refuses every save", async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Fence Admin", "admin");
    authenticate(org.orgId, actorId);
    await emptyBom(org.orgId, org.items.assembly);
    for (const fields of [{ operationSeq: 2 }, { isByproduct: true }]) {
      const response = await PUT(putRequest({
        ...recipe(org.items.assembly, org.items.component),
        components: [{ componentItemId: org.items.component, quantityPer: "1", ...fields }],
      }));
      assert.equal(response.status, 404);
      assert.deepEqual(await bomRows(org.orgId, org.items.assembly), []);
      assert.deepEqual(await bomAudits(org.orgId, org.items.assembly), []);
    }
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"inventory":false}'::jsonb)
       where id = ${org.orgId}`);

    const res = await PUT(putRequest(recipe(org.items.assembly, org.items.component)));
    assert.equal(res.status, 404);
    assert.deepEqual(await bomRows(org.orgId, org.items.assembly), [], "the refused save stores no recipe");
    assert.deepEqual(await bomAudits(org.orgId, org.items.assembly), [], "the refused save audits nothing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("BOM replacement accepts adjacent effectivity windows and names overlapping dates", async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Effectivity Admin", "admin");
    authenticate(org.orgId, actorId);
    await emptyBom(org.orgId, org.items.assembly);
    const base = recipe(org.items.assembly, org.items.component);
    const first = { componentItemId: org.items.component, quantityPer: "1", effectiveFrom: "2026-01-01", effectiveTo: "2026-07-01" };
    const second = { componentItemId: org.items.component, quantityPer: "2", effectiveFrom: "2026-07-01" };
    const accepted = await PUT(putRequest({ ...base, components: [first, second] }));
    assert.equal(accepted.status, 200);
    const version = (await accepted.json() as { version: string }).version;
    assert.equal((await bomRows(org.orgId, org.items.assembly)).length, 2);
    const detail = await GET(new Request(`http://localhost/api/inventory/bom?assemblyItemId=${org.items.assembly}`));
    const detailBody = await detail.json() as { version: string; components: { effectiveFrom: string | null; effectiveTo: string | null }[] };
    assert.equal(detailBody.version, version);
    assert.deepEqual(detailBody.components.map((line) => [line.effectiveFrom, line.effectiveTo]), [["2026-01-01", "2026-07-01"], ["2026-07-01", null]]);
    const refused = await PUT(putRequest({ ...base, expectedVersion: version, components: [
      { ...first, effectiveTo: "2026-08-01" }, { ...second, effectiveFrom: "2026-07-01" },
    ] }));
    const body = await refused.json() as { error: string; componentItemId: string };
    assert.equal(refused.status, 422);
    assert.equal(body.componentItemId, org.items.component);
    assert.match(body.error, /2026-01-01.*2026-08-01.*2026-07-01/);
    assert.equal((await bomRows(org.orgId, org.items.assembly)).length, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a manufacturing planner reads the revision context with every operating entity and no elimination entity", async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Planner", "admin");
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["admin.setup.manage", "manufacturing.manage"]),
      allowedSubsidiaryIds: null,
    };
    const elimination = (await db.execute<{ id: string }>(sql`
      insert into subsidiaries (org_id, parent_id, name, base_currency, country, is_elimination, is_active)
      select org_id, id, 'Group eliminations', base_currency, country, true, true
        from subsidiaries where org_id = ${org.orgId} and id = ${org.subsidiaryId}
      returning id`)).rows[0]!.id;
    const context = await GET(new Request("http://localhost/api/inventory/bom"));
    assert.equal(context.status, 200);
    const contextBody = await context.json() as { canProposeRevision: boolean; subsidiaries: { id: string }[] };
    assert.equal(contextBody.canProposeRevision, true);
    const ids = contextBody.subsidiaries.map((row) => row.id);
    assert.ok(ids.includes(org.subsidiaryId), "the operating entity is offered for a revision proposal");
    assert.ok(!ids.includes(elimination), "an elimination entity never holds a recipe revision");
    const detail = await GET(new Request(`http://localhost/api/inventory/bom?assemblyItemId=${org.items.assembly}`));
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { assemblyItemId: string }).assemblyItemId, org.items.assembly);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("GET names component lines from catalog identity and keeps inactive lines as evidence", async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Read Admin", "admin");
    authenticate(org.orgId, actorId);
    await emptyBom(org.orgId, org.items.assembly);
    const saved = await PUT(putRequest(recipe(org.items.assembly, org.items.component)));
    assert.equal(saved.status, 200);
    const detail = await GET(new Request(`http://localhost/api/inventory/bom?assemblyItemId=${org.items.assembly}`));
    assert.equal(detail.status, 200);
    const body = await detail.json() as {
      assemblyItemId: string;
      version: string;
      components: { componentItemId: string; code: string | null; name: string | null; isActive: boolean | null; isCurrent: boolean }[];
      validItems: { id: string; code: string | null; name: string | null }[];
    };
    assert.equal(body.assemblyItemId, org.items.assembly);
    assert.equal(body.components.length, 1);
    assert.equal(body.components[0]!.componentItemId, org.items.component);
    assert.equal(body.components[0]!.name, "Component");
    assert.equal(body.components[0]!.isActive, true);
    assert.equal(body.components[0]!.isCurrent, true);
    assert.ok(body.validItems.some((item) => item.id === org.items.component && item.name === "Component"));
    // Deactivating the component removes it from the editor's eligible
    // choices, but the stored line still names it instead of falling back
    // to its storage id.
    await db.execute(sql`update items set is_active = false where org_id = ${org.orgId} and id = ${org.items.component}`);
    const reread = await GET(new Request(`http://localhost/api/inventory/bom?assemblyItemId=${org.items.assembly}`));
    assert.equal(reread.status, 200);
    const rebody = await reread.json() as typeof body;
    assert.equal(rebody.components.length, 1);
    assert.equal(rebody.components[0]!.name, "Component");
    assert.equal(rebody.components[0]!.isActive, false);
    assert.ok(!rebody.validItems.some((item) => item.id === org.items.component));
    // Reading serves both grants: the catalog grant opens the recipe to a
    // reader who cannot change it, and the established setup grant keeps
    // working. A caller with neither is refused naming the primary grant.
    const readerUrl = `http://localhost/api/inventory/bom?assemblyItemId=${org.items.assembly}`;
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["items.read"]),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    const reader = await GET(new Request(readerUrl));
    assert.equal(reader.status, 200);
    assert.equal((await reader.json() as { assemblyItemId: string }).assemblyItemId, org.items.assembly);
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["unrelated.hold"]),
      allowedSubsidiaryIds: null,
    };
    const refused = await GET(new Request(readerUrl));
    assert.equal(refused.status, 403);
    assert.equal((await refused.json() as { error: string }).error, "missing permission: items.read");
    // A catalog reader cannot replace the shared recipe: the write gate
    // refuses naming its own grant before any read or write.
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["items.read"]),
      allowedSubsidiaryIds: null,
    };
    const readerPut = await PUT(putRequest(recipe(org.items.assembly, org.items.component)));
    assert.equal(readerPut.status, 403);
    assert.equal((await readerPut.json() as { error: string }).error, "missing permission: admin.setup.manage");
    // A line bounded entirely in the past reads back not current, under the
    // same half-open window the kit explosion enforces. The component is
    // reactivated first: the save gate only accepts active inventory items.
    await db.execute(sql`update items set is_active = true where org_id = ${org.orgId} and id = ${org.items.component}`);
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const rereadForVersion = await GET(new Request(readerUrl));
    const currentVersion = (await rereadForVersion.json() as { version: string }).version;
    const dated = await PUT(putRequest({
      assemblyItemId: org.items.assembly,
      expectedVersion: currentVersion,
      reason: "Window regression probe: one line bounded in the past.",
      components: [{
        componentItemId: org.items.component,
        quantityPer: "2",
        operationSeq: null,
        scrapPct: null,
        isByproduct: false,
        effectiveFrom: "2000-01-01",
        effectiveTo: "2001-01-01",
      }],
    }));
    assert.equal(dated.status, 200);
    const datedGet = await GET(new Request(readerUrl));
    const datedBody = await datedGet.json() as {
      components: { componentItemId: string; isCurrent: boolean }[];
    };
    assert.equal(datedBody.components.length, 1);
    assert.equal(datedBody.components[0]!.isCurrent, false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a BOM save waits for an in-flight Inventory disable, then refuses it", async () => {
  const org = await createScratchOrg();
  const writer = await pool.connect();
  let pending: Promise<{ status: number }> | undefined;
  try {
    const actorId = await createScratchUser(org.orgId, "BOM Fence Race Admin", "admin");
    authenticate(org.orgId, actorId);
    await emptyBom(org.orgId, org.items.assembly);

    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{\"inventory\":false}'::jsonb) where id=$1", [org.orgId]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

    pending = PUT(putRequest(recipe(org.items.assembly, org.items.component)))
      .then(async (res) => ({ status: res.status }));

    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = (await pool.query<{ blocked: boolean }>(
        "select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
      if (row.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "the save must wait for authoritative feature ownership instead of racing past the disable");
    await writer.query("commit");

    const result = await pending;
    assert.equal(result.status, 404, "the disable that won the race refuses the save");
    assert.deepEqual(await bomRows(org.orgId, org.items.assembly), [], "the refused save stores no recipe");
    assert.deepEqual(await bomAudits(org.orgId, org.items.assembly), [], "the refused save audits nothing");
  } finally {
    await writer.query("rollback").catch(() => {});
    writer.release();
    await pending?.catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});

test("a subsidiary-scoped setup manager cannot replace the shared recipe", async () => {
  // The org-wide-policy gate fires before the body parses, so no database
  // is needed to prove the refusal precedes every read and write.
  routeState.authz = {
    user: { orgId: "00000000-0000-4000-8000-00000000b001", id: "00000000-0000-4000-8000-00000000b002" },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: new Set(["00000000-0000-4000-8000-00000000b003"]),
  };
  try {
    const response = await PUT(
      putRequest(
        recipe(
          "00000000-0000-4000-8000-00000000b004",
          "00000000-0000-4000-8000-00000000b005",
        ),
      ),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  } finally {
    routeState.authz = null;
  }
});
