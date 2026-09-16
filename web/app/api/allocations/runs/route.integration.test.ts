import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A8 runs + lineage API: list filters, detail scoping, preview/post/
// reverse/rerun wiring against a fake period-run engine (the default
// binding is pending on A3 → 503), reason enforcement, lineage anchors.

const stateKey = Symbol.for("openbooks.alloc-runs-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: string[] | null;
  } | null;
  NextResponse: typeof import("next/server").NextResponse | null;
}
const routeState: RouteState = { authz: null, NextResponse: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.alloc-runs-route-test')]
  const { NextResponse } = state
  export async function guardPermission(permission) {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const perms = state.authz.permissions
    const covered = perms.has(permission) || perms.has('*') ||
      [...perms].some((p) => p.endsWith('.*') && permission.startsWith(p.slice(0, -1)))
    if (!covered) return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
    if (state.authz.allowedSubsidiaryIds === null) return { ...state.authz, allowedSubsidiaryIds: null }
    return { ...state.authz, allowedSubsidiaryIds: new Set(state.authz.allowedSubsidiaryIds) }
  }
`;

routeState.NextResponse = (await import("next/server")).NextResponse;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "./authz" && String(context.parentURL ?? "").includes("lib/allocations-gate.ts")) {
      return { url: "mock:runs-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:runs-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const listUrl = "./route.ts?alloc-runs";
const detailUrl = "./[id]/route.ts?alloc-runs";
const previewUrl = "./preview/route.ts?alloc-runs";
const postUrl = "./[id]/post/route.ts?alloc-runs";
const reverseUrl = "./[id]/reverse/route.ts?alloc-runs";
const rerunUrl = "./[id]/rerun/route.ts?alloc-runs";
const listRoute = (await import(listUrl)) as typeof import("./route.ts");
const detailRoute = (await import(detailUrl)) as typeof import("./[id]/route.ts");
const previewRoute = (await import(previewUrl)) as typeof import("./preview/route.ts");
const postRoute = (await import(postUrl)) as typeof import("./[id]/post/route.ts");
const reverseRoute = (await import(reverseUrl)) as typeof import("./[id]/reverse/route.ts");
const rerunRoute = (await import(rerunUrl)) as typeof import("./[id]/rerun/route.ts");
const lineageUrl = "../lineage/route.ts?alloc-runs";
const lineageRoute = (await import(lineageUrl)) as typeof import("../lineage/route.ts");
hooks.deregister();

const { db } = await import("../../../../../engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "../../../../../engine/src/test-fixtures.ts"
);
const { pendingPeriodRunEngine, setPeriodRunEngine } = await import(
  "../../../../../engine/src/allocations/a8-shims.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

function authenticate(orgId: string, actorId: string, permissions: string[], allowedSubsidiaryIds: string[] | null = null): void {
  routeState.authz = { user: { orgId, id: actorId }, permissions: new Set(permissions), allowedSubsidiaryIds };
}

async function enableAllocations(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,allocations}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Setup {
  orgId: string;
  actorId: string;
  ruleId: string;
  runId: string;
  periodId: string;
  bookId: string;
  subsidiaryId: string;
}

async function setup(): Promise<Setup> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await enableAllocations(org.orgId);
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const runId = randomUUID();
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, created_by, updated_by)
    values (${ruleId}, ${org.orgId}, 'route-sweep', 'Route sweep', 'period', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, definition_hash, created_by, updated_by)
    values
      (${versionId}, ${org.orgId}, ${ruleId}, 1, 'published', '2026-01-01', 'hash-r', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into allocation_runs
      (id, org_id, rule_id, version_id, definition_hash, period_id, book_id, subsidiary_id,
       status, trigger_kind, source_total, allocated_total, residual, computation, requested_by, created_by, updated_by)
    values
      (${runId}, ${org.orgId}, ${ruleId}, ${versionId}, 'hash-r', ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
       'previewed', 'manual', '10.00', '10.00', '0.00', '{}'::jsonb, ${actorId}, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into allocation_lineage
      (org_id, mode, rule_id, version_id, definition_hash, run_id, amount, share)
    values
      (${org.orgId}, 'period', ${ruleId}, ${versionId}, 'hash-r', ${runId}, '10.00', '1.0')`);
  return { orgId: org.orgId, actorId, ruleId, runId, periodId: org.periodId, bookId: org.bookId, subsidiaryId: org.subsidiaryId };
}

test("runs list filters + detail subsidiary scoping", { skip: !DB }, async () => {
  const s = await setup();
  try {
    authenticate(s.orgId, s.actorId, ["allocations.read", "allocations.run", "gl.post"]);
    const listed = await listRoute.GET(jsonRequest("/api/allocations/runs?status=previewed", "GET"));
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { runs: { id: string }[]; total: number };
    assert.equal(body.total, 1);
    assert.equal(body.runs[0]?.id, s.runId);

    const badStatus = await listRoute.GET(jsonRequest("/api/allocations/runs?status=nope", "GET"));
    assert.equal(badStatus.status, 400);
    const badUuid = await listRoute.GET(jsonRequest("/api/allocations/runs?ruleId=nope", "GET"));
    assert.equal(badUuid.status, 400);

    const detail = await detailRoute.GET(jsonRequest(`/api/allocations/runs/${s.runId}`, "GET"), {
      params: Promise.resolve({ id: s.runId }),
    });
    assert.equal(detail.status, 200);

    // Restricted to nothing: the subsidiary-pinned run disappears.
    authenticate(s.orgId, s.actorId, ["allocations.read", "allocations.run", "gl.post"], []);
    const hidden = await listRoute.GET(jsonRequest("/api/allocations/runs", "GET"));
    assert.deepEqual(await hidden.json(), { runs: [], total: 0 });
    const hiddenDetail = await detailRoute.GET(jsonRequest(`/api/allocations/runs/${s.runId}`, "GET"), {
      params: Promise.resolve({ id: s.runId }),
    });
    assert.equal(hiddenDetail.status, 404);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(s.orgId);
  }
});

test("preview wires the engine; pending by default", { skip: !DB }, async () => {
  const s = await setup();
  try {
    authenticate(s.orgId, s.actorId, ["allocations.run"]);
    const body = { ruleId: s.ruleId, periodId: s.periodId, bookId: s.bookId };

    const pending = await previewRoute.POST(jsonRequest("/api/allocations/runs/preview", "POST", body));
    assert.equal(pending.status, 503);
    assert.equal(((await pending.json()) as { errorCode: string }).errorCode, "engine_pending");

    const seen: unknown[] = [];
    setPeriodRunEngine({
      preview: async (input) => { seen.push(input); return { ruleId: s.ruleId } as never; },
      post: async () => { throw new Error("unused"); },
      reverse: async () => { throw new Error("unused"); },
      rerun: async () => { throw new Error("unused"); },
    });
    try {
      const ok = await previewRoute.POST(jsonRequest("/api/allocations/runs/preview", "POST", body));
      assert.equal(ok.status, 200);
      assert.equal(seen.length, 1);
      assert.match(JSON.stringify(seen[0]), /manual/);
    } finally {
      setPeriodRunEngine(pendingPeriodRunEngine);
    }

    authenticate(s.orgId, s.actorId, ["allocations.run"], []);
    const scoped = await previewRoute.POST(jsonRequest("/api/allocations/runs/preview", "POST", {
      ...body,
      subsidiaryId: s.subsidiaryId,
    }));
    assert.equal(scoped.status, 403);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(s.orgId);
  }
});

test("post/reverse/rerun need gl.post + reason; pending on A3", { skip: !DB }, async () => {
  const s = await setup();
  try {
    authenticate(s.orgId, s.actorId, ["allocations.run"]);
    const noGl = await postRoute.POST(
      jsonRequest(`/api/allocations/runs/${s.runId}/post`, "POST", { reason: "close" }),
      { params: Promise.resolve({ id: s.runId }) },
    );
    assert.equal(noGl.status, 403);

    authenticate(s.orgId, s.actorId, ["allocations.run", "gl.post"]);
    const noReason = await postRoute.POST(
      jsonRequest(`/api/allocations/runs/${s.runId}/post`, "POST", { reason: "" }),
      { params: Promise.resolve({ id: s.runId }) },
    );
    assert.equal(noReason.status, 400);

    const calls: { kind: string; input: unknown }[] = [];
    setPeriodRunEngine({
      preview: async () => { throw new Error("unused"); },
      post: async (input) => { calls.push({ kind: "post", input }); return { runId: s.runId, journalEntryId: null }; },
      reverse: async (input) => { calls.push({ kind: "reverse", input }); return { reversalEntryId: null }; },
      rerun: async (input) => { calls.push({ kind: "rerun", input }); return { runId: randomUUID() }; },
    });
    try {
      const posted = await postRoute.POST(
        jsonRequest(`/api/allocations/runs/${s.runId}/post`, "POST", { reason: "month-end" }),
        { params: Promise.resolve({ id: s.runId }) },
      );
      assert.equal(posted.status, 200);
      const reversed = await reverseRoute.POST(
        jsonRequest(`/api/allocations/runs/${s.runId}/reverse`, "POST", { reason: "correction" }),
        { params: Promise.resolve({ id: s.runId }) },
      );
      assert.equal(reversed.status, 200);
      const reran = await rerunRoute.POST(
        jsonRequest(`/api/allocations/runs/${s.runId}/rerun`, "POST"),
        { params: Promise.resolve({ id: s.runId }) },
      );
      assert.equal(reran.status, 200);
      assert.deepEqual(calls.map((c) => c.kind), ["post", "reverse", "rerun"]);
      assert.match(JSON.stringify(calls[0]?.input), /month-end/);
    } finally {
      setPeriodRunEngine(pendingPeriodRunEngine);
    }
  } finally {
    routeState.authz = null;
    await dropScratchOrg(s.orgId);
  }
});

test("lineage drill anchors on one object", { skip: !DB }, async () => {
  const s = await setup();
  try {
    authenticate(s.orgId, s.actorId, ["allocations.read"]);
    const byRun = await lineageRoute.GET(jsonRequest(`/api/allocations/lineage?runId=${s.runId}`, "GET"));
    assert.equal(byRun.status, 200);
    const rows = ((await byRun.json()) as { rows: { amount: string }[] }).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.amount, "10.0000");

    const none = await lineageRoute.GET(jsonRequest("/api/allocations/lineage", "GET"));
    assert.equal(none.status, 400);
    const two = await lineageRoute.GET(
      jsonRequest(`/api/allocations/lineage?runId=${s.runId}&documentId=${randomUUID()}`, "GET"),
    );
    assert.equal(two.status, 400);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(s.orgId);
  }
});
