import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Contract regression for the generic Setup route's ownership validation
// (web/app/api/admin/setup/[entity]/route.ts). The ownership-interest check
// used to build a uuid[] literal out of request ids; a malformed account id
// must be refused as the documented client error at the boundary — never a
// server-side 22P02 escaping as a 500, and never a partial write.
const stateKey = Symbol.for("openbooks.setup-route-contract-test");
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
  const state = globalThis[Symbol.for('openbooks.setup-route-contract-test')]
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
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    const entityRoute = context.parentURL?.includes("%5Bentity%5D")
      ?? context.parentURL?.includes("[entity]");
    if (specifier === "../../../../../lib/authz" && entityRoute) {
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

const routeUrl = "../app/api/admin/setup/[entity]/route.ts?setup-route-contract-test";
const { PATCH, POST } = (await import(routeUrl)) as typeof import("../app/api/admin/setup/[entity]/route.ts");
const setupResourceUrl = "./data-io/setup-resources.ts?segment-hierarchy-contract-test";
const { setupResource } = (await import(setupResourceUrl)) as typeof import("./data-io/setup-resources.ts");
const { SETUP_ENTITY_BY_KEY } = await import("./setup/registry.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

test("segment hierarchy API validation walks scoped descendants before the write", () => {
  const source = readFileSync(
    new URL("../app/api/admin/setup/[entity]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /with recursive descendants as \([\s\S]*where id = \$\{rowId\} and org_id = \$\{orgId\} and segment_id = \$\{segmentId\}[\s\S]*where value\.org_id = \$\{orgId\} and value\.segment_id = \$\{segmentId\}/,
  );
  assert.match(source, /A segment value cannot be parented beneath itself/);
  const preflight = source.lastIndexOf("const integrityError = await validateEntityIntegrity");
  const write = source.lastIndexOf("const found = await setupWriteTransaction");
  assert.ok(preflight >= 0 && preflight < write, "PATCH integrity validation must precede its write transaction");
});

interface Fixture {
  orgId: string;
  actorId: string;
  parentSubsidiaryId: string;
  childSubsidiaryId: string;
  /** non-summary posting accounts usable as ownership-account targets */
  investmentAccountId: string;
  equityIncomeAccountId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Setup Admin", "admin");
  // The ownership entity sits behind the Multi-subsidiary feature gate.
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ multiSubsidiary: true })}::jsonb)
     where id = ${org.orgId}`);
  const childSubsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${childSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Child Co', 'CAD', 'CA')`);
  return {
    orgId: org.orgId,
    actorId,
    parentSubsidiaryId: org.subsidiaryId,
    childSubsidiaryId,
    // asset_current_other / income — the types the integrity rules demand for
    // a fully-owned interest's investment and equity-income legs.
    investmentAccountId: org.accounts.invAsset,
    equityIncomeAccountId: org.accounts.revenue,
  };
}

function postRequest(entity: string, body: unknown): Request {
  return new Request(`http://localhost/api/admin/setup/${entity}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patchRequest(entity: string, body: unknown): Request {
  return new Request(`http://localhost/api/admin/setup/${entity}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** A fully-owned interest: every required field present and type-correct.
 * Proportionate method keeps the control free of the full-consolidation
 * trigger's extra goodwill/fair-value account requirements. */
function validOwnershipBody(f: Fixture): Record<string, unknown> {
  return {
    parentSubsidiaryId: f.parentSubsidiaryId,
    subsidiaryId: f.childSubsidiaryId,
    effectiveFrom: "2026-07-01",
    ownershipPercent: "100",
    method: "proportionate",
    nciMeasurement: "proportionate",
    acquisitionDate: "2026-01-01",
    acquisitionCost: "1000",
    fairValueNetAssets: "1000",
    acquisitionRate: "1",
    investmentAccountId: f.investmentAccountId,
    equityIncomeAccountId: f.equityIncomeAccountId,
    isActive: true,
  };
}

async function persistedInterestCount(orgId: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from subsidiary_ownership_interests where org_id = ${orgId}`);
  return r.rows[0]!.n;
}

async function persistedAuditCount(orgId: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'subsidiary_ownership_interests'`);
  return r.rows[0]!.n;
}

test("a valid ownership write persists the interest with audit evidence", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const res = await POST(postRequest("subsidiary-ownership-interests", validOwnershipBody(f)), {
      params: Promise.resolve({ entity: "subsidiary-ownership-interests" }),
    });
    assert.equal(res.status, 200);
    const { id } = (await res.json()) as { id: string };
    assert.ok(id);

    const row = ((await db.execute(sql`
      select method, ownership_percent as "ownershipPercent", investment_account_id as "investmentAccountId"
        from subsidiary_ownership_interests where id = ${id} and org_id = ${f.orgId}`))).rows[0];
    assert.ok(row);
    assert.equal(row.method, "proportionate");
    assert.equal(Number(row.ownershipPercent), 100);
    assert.equal(row.investmentAccountId, f.investmentAccountId);

    const audits = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${f.orgId} and table_name = 'subsidiary_ownership_interests'
         and row_id = ${id} and action = 'insert'`);
    assert.equal(audits.rows[0]!.n, 1);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a malformed or hostile ownership account id is a contract 400 that writes nothing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const beforeInterests = await persistedInterestCount(f.orgId);
    const beforeAudits = await persistedAuditCount(f.orgId);
    const beforeAccounts = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from accounts where org_id = ${f.orgId}`);

    // Malformed uuid, SQL syntax, and an empty value that would form a
    // malformed array literal if it ever reached a cast.
    for (const [label, override] of [
      ["not-a-uuid", { investmentAccountId: "not-a-uuid" }],
      ["sql-syntax", { investmentAccountId: "x'); drop table accounts;--" }],
      ["empty", { equityIncomeAccountId: "" }],
    ] as const) {
      const res = await POST(
        postRequest("subsidiary-ownership-interests", { ...validOwnershipBody(f), ...override }),
        { params: Promise.resolve({ entity: "subsidiary-ownership-interests" }) },
      );
      assert.equal(res.status, 400, `${label}: expected the documented 400 contract`);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, `${label}: JSON, not HTML`);
      const body = (await res.json()) as { error: string };
      assert.equal(typeof body.error, "string");
      assert.ok(body.error.length > 0, `${label}: carries a client-facing message`);
    }

    assert.equal(await persistedInterestCount(f.orgId), beforeInterests);
    assert.equal(await persistedAuditCount(f.orgId), beforeAudits);
    const afterAccounts = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from accounts where org_id = ${f.orgId}`);
    assert.equal(afterAccounts.rows[0]!.n, beforeAccounts.rows[0]!.n);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

interface SegmentFixture {
  orgId: string;
  actorId: string;
  segmentId: string;
  otherSegmentId: string;
  rootId: string;
  childId: string;
  grandchildId: string;
  otherSegmentValueId: string;
}

async function seedSegmentFixture(): Promise<SegmentFixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Segment Setup Admin", "admin");
  const segmentId = randomUUID();
  const otherSegmentId = randomUUID();
  const rootId = randomUUID();
  const childId = randomUUID();
  const grandchildId = randomUUID();
  const otherSegmentValueId = randomUUID();
  await db.execute(sql`
    insert into segment_definitions
      (id, org_id, key, name, plural_name, source_kind, is_hierarchical)
    values
      (${segmentId}, ${org.orgId}, 'region_tree', 'Region', 'Regions', 'custom', true),
      (${otherSegmentId}, ${org.orgId}, 'channel_tree', 'Channel', 'Channels', 'custom', true)`);
  await db.execute(sql`
    insert into segment_values (id, org_id, segment_id, parent_id, code, name)
    values
      (${rootId}, ${org.orgId}, ${segmentId}, null, 'ROOT', 'Root'),
      (${childId}, ${org.orgId}, ${segmentId}, ${rootId}, 'CHILD', 'Child'),
      (${grandchildId}, ${org.orgId}, ${segmentId}, ${childId}, 'GRANDCHILD', 'Grandchild'),
      (${otherSegmentValueId}, ${org.orgId}, ${otherSegmentId}, null, 'OTHER', 'Other segment root')`);
  return {
    orgId: org.orgId,
    actorId,
    segmentId,
    otherSegmentId,
    rootId,
    childId,
    grandchildId,
    otherSegmentValueId,
  };
}

function segmentValueBody(f: SegmentFixture, id: string, name: string, parentId: string | null) {
  return {
    id,
    segmentId: f.segmentId,
    code: name.toUpperCase(),
    name,
    description: null,
    parentId,
    subsidiaryId: null,
    subsidiaryIncludeChildren: true,
    isActive: true,
  };
}

async function segmentAuditCount(orgId: string): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'segment_values'`);
  return result.rows[0]!.n;
}

test("segment value PATCH preflights cycles and preserves the audited valid path", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seedSegmentFixture();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const beforeAudits = await segmentAuditCount(f.orgId);
    const rejected = await PATCH(
      patchRequest("segment-values", segmentValueBody(f, f.rootId, "Root", f.grandchildId)),
      { params: Promise.resolve({ entity: "segment-values" }) },
    );
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "A segment value cannot be parented beneath itself" });
    assert.equal(await segmentAuditCount(f.orgId), beforeAudits, "cycle preflight writes no audit or row");

    const accepted = await PATCH(
      patchRequest("segment-values", segmentValueBody(f, f.grandchildId, "Grandchild", f.rootId)),
      { params: Promise.resolve({ entity: "segment-values" }) },
    );
    assert.equal(accepted.status, 200);
    const stored = await db.execute<{ parent_id: string | null }>(sql`
      select parent_id from segment_values where id = ${f.grandchildId} and org_id = ${f.orgId}`);
    assert.equal(stored.rows[0]?.parent_id, f.rootId);
    assert.equal(await segmentAuditCount(f.orgId), beforeAudits + 1);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("segment value imports inherit storage scope enforcement and audit valid writes", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seedSegmentFixture();
  try {
    const entity = SETUP_ENTITY_BY_KEY.get("segment-values");
    assert.ok(entity);
    const resource = setupResource(entity, f.orgId);
    const beforeAudits = await segmentAuditCount(f.orgId);
    const invalid = await resource.write([
      {
        segmentId: "region_tree",
        code: "INVALID",
        name: "Invalid cross-segment child",
        parentId: f.otherSegmentValueId,
        isActive: true,
      },
    ], "insert", { orgId: f.orgId, actorId: f.actorId, dryRun: false });
    assert.equal(invalid.failed, 1);
    assert.equal(invalid.created, 0);
    assert.match(invalid.errors[0]?.message ?? "", /segment value parent is invalid/);
    assert.equal(await segmentAuditCount(f.orgId), beforeAudits, "rejected import has no orphan audit");

    const valid = await resource.write([
      {
        segmentId: "region_tree",
        code: "IMPORTED",
        name: "Imported child",
        parentId: f.rootId,
        isActive: true,
      },
    ], "insert", { orgId: f.orgId, actorId: f.actorId, dryRun: false });
    assert.deepEqual(
      { created: valid.created, failed: valid.failed },
      { created: 1, failed: 0 },
    );
    const imported = await db.execute<{ id: string }>(sql`
      select id from segment_values
       where org_id = ${f.orgId} and segment_id = ${f.segmentId} and code = 'IMPORTED'`);
    assert.ok(imported.rows[0]);
    const audit = await db.execute<{ source: string | null }>(sql`
      select changes->>'source' as source from audit_log
       where org_id = ${f.orgId} and table_name = 'segment_values'
         and row_id = ${imported.rows[0]!.id} and action = 'insert'`);
    assert.deepEqual(audit.rows, [{ source: "import" }]);
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});
