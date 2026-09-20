import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A8 runs + lineage API: list filters, detail scoping, preview/post/
// reverse/rerun wiring against the real period-run engine, reason
// enforcement, lineage anchors.

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

const { db } = await import("../../../../../engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "../../../../../engine/src/testing/fixtures.ts"
);
const { postProjectGlEntry } = await import(
  "../../../../../engine/src/projects/recognition.ts"
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
  postingDate: string;
}

async function setup(): Promise<Setup> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const postingDate = org.date;
  await enableAllocations(org.orgId);
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const runId = randomUUID();
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, created_by, updated_by)
    values (${ruleId}, ${org.orgId}, 'route-sweep', 'Route sweep', 'period', ${actorId}, ${actorId})`);
  // Targets are immutable once published: draft → targets → publish.
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, account_scope, created_by, updated_by)
    values
      (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01',
       ${JSON.stringify({ kind: "accounts", accountIds: [org.accounts.adjustment] })}::jsonb,
       ${actorId}, ${actorId})`);
  // A real sweep target plus a real source pool for the engine-backed tests.
  const deptId = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active, custom)
    values (${deptId}, ${org.orgId}, 'Route Dept', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into allocation_rule_targets
      (id, org_id, version_id, sequence, department_id, fixed_percent, is_remainder, label, custom)
    values (${randomUUID()}, ${org.orgId}, ${versionId}, 1, ${deptId}, '100.0000', false, 'Route Dept', '{}'::jsonb)`);
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = 'hash-r', published_at = now()
     where id = ${versionId} and org_id = ${org.orgId}`);
  await postProjectGlEntry({
    orgId: org.orgId,
    actorId,
    origin: "manual",
    entryNumber: `ROUTE-SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Route sweep pool",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount: "100.0000" },
      { accountId: org.accounts.bank, amount: "-100.0000" },
    ],
  });
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
  return { orgId: org.orgId, actorId, ruleId, runId, periodId: org.periodId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, postingDate };
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

test("preview runs the real engine", { skip: !DB }, async () => {
  const s = await setup();
  try {
    authenticate(s.orgId, s.actorId, ["allocations.run"]);
    const body = { ruleId: s.ruleId, periodId: s.periodId, bookId: s.bookId };

    const ok = await previewRoute.POST(jsonRequest("/api/allocations/runs/preview", "POST", body));
    assert.equal(ok.status, 200);
    const computation = ((await ok.json()) as { computation: { sourceTotal: string } }).computation;
    assert.equal(computation.sourceTotal, "100.0000");

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

test("preview resolves report drivers through the production composition", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    await enableAllocations(org.orgId);
    // The engine runner enforces reports.read under the actor identity.
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${org.orgId}, ${actorId}, 'reports.read', 'grant')`);
    const adjustment = org.accounts.adjustment;
    const bank = org.accounts.bank;
    await postProjectGlEntry({
      orgId: org.orgId,
      actorId,
      origin: "manual",
      entryNumber: `ROUTE-SVC-${randomUUID()}`,
      postingDate: org.date,
      memo: "Route service pool",
      subsidiaryId: org.subsidiaryId,
      currency: "CAD",
      lines: [
        { accountId: adjustment, amount: "1000.0000" },
        { accountId: bank, amount: "-1000.0000" },
      ],
    });
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
      values (${definitionId}, ${org.orgId}, 'custom', 'driver-route-service', 'Driver route service', 'query',
        ${JSON.stringify({
          entity: "ledger_lines",
          mode: "summarize",
          columns: [],
          breakouts: [{ column: "account_id" }],
          measures: [{ fn: "sum", column: "debit" }],
        })}::jsonb)`);
    const driverId = randomUUID();
    await db.execute(sql`
      insert into allocation_drivers (id, org_id, key, name, dimension, source_kind, config, is_active)
      values (${driverId}, ${org.orgId}, 'route-svc-report', 'Route service report', 'extra:account',
              'report_definition',
              ${JSON.stringify({
                reportDefinitionId: definitionId,
                dimensionColumn: "account_id",
                valueColumn: "debit",
                params: {},
              })}::jsonb, true)`);
    const ruleId = randomUUID();
    const versionId = randomUUID();
    await db.execute(sql`
      insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
      values (${ruleId}, ${org.orgId}, 'route-svc-rule', 'Route service rule', 'period', 100, true, false, '{}'::jsonb)`);
    await db.execute(sql`
      insert into allocation_rule_versions
        (id, org_id, rule_id, version_no, status, effective_from, effective_to,
         book_scope, book_ids, account_scope, dimension_filters, source_measure,
         basis_kind, driver_id, driver_as_of, basis_config,
         target_kind, dynamic_target, impact, residual_policy, solve_method,
         run_policy, run_offset_days, memo_template, published_at)
      values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
         'primary', '[]'::jsonb,
         ${JSON.stringify({ kind: "accounts", accountIds: [adjustment] })}::jsonb,
         '{}'::jsonb, 'period_activity',
         'driver', ${driverId}, 'period', '{}'::jsonb,
         'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential',
         'manual', 0, 'Route {{rule.name}} for {{period.name}}', now())`);
    for (const [sequence, accountId] of [adjustment, bank].entries()) {
      await db.execute(sql`
        insert into allocation_rule_targets
          (id, org_id, version_id, sequence, target_account_id, extra_dims, label, custom)
        values (${randomUUID()}, ${org.orgId}, ${versionId}, ${sequence + 1}, null,
                ${JSON.stringify({ account: accountId })}::jsonb, ${`Target ${sequence + 1}`}, '{}'::jsonb)`);
    }
    await db.execute(sql`
      update allocation_rule_versions
         set status = 'published', definition_hash = ${`testhash-${versionId}`}, published_at = now()
       where id = ${versionId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      update allocation_rules set current_version_id = ${versionId}
       where id = ${ruleId} and org_id = ${org.orgId}`);

    authenticate(org.orgId, actorId, ["allocations.run"]);
    const res = await previewRoute.POST(
      jsonRequest("/api/allocations/runs/preview", "POST", {
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
      }),
    );
    assert.equal(res.status, 200);
    const computation = (
      await res.json()
    ) as {
      computation: {
        sourceTotal: string;
        driver: { vector: { key: string; value: string }[] } | null;
      };
    };
    assert.equal(computation.computation.sourceTotal, "1000.0000");
    const vector = new Map(
      (computation.computation.driver?.vector ?? []).map((e) => [e.key, e.value] as [string, string]),
    );
    assert.equal(vector.get(adjustment), "1000.0000");
    assert.equal(vector.get(bank), "0.0000");
    assert.deepEqual(
      (computation.computation.driver as unknown as { temporal?: unknown } | null)?.temporal,
      { mode: "balance_as_of", from: null, to: "2026-07-31", field: null },
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("post/reverse/rerun need gl.post + reason and run the real engine", { skip: !DB }, async () => {
  const s = await setup();
  try {
    authenticate(s.orgId, s.actorId, ["allocations.run"]);
    const noGl = await postRoute.POST(
      jsonRequest(`/api/allocations/runs/${s.runId}/post`, "POST", { reason: "close" }),
      { params: Promise.resolve({ id: s.runId }) },
    );
    assert.equal(noGl.status, 403);

    authenticate(s.orgId, s.actorId, ["allocations.run", "gl.post", "allocations.read"]);
    const noReason = await postRoute.POST(
      jsonRequest(`/api/allocations/runs/${s.runId}/post`, "POST", { reason: "" }),
      { params: Promise.resolve({ id: s.runId }) },
    );
    assert.equal(noReason.status, 400);

    // A real preview first: the seeded run row carries no computation.
    const previewed = await previewRoute.POST(
      jsonRequest("/api/allocations/runs/preview", "POST", {
        ruleId: s.ruleId,
        periodId: s.periodId,
        bookId: s.bookId,
      }),
    );
    assert.equal(previewed.status, 200);
    const listed = await listRoute.GET(
      jsonRequest(`/api/allocations/runs?ruleId=${s.ruleId}&status=previewed`, "GET"),
    );
    const previewId = ((await listed.json()) as { runs: { id: string }[] }).runs[0]?.id;
    assert.ok(previewId);

    const posted = await postRoute.POST(
      jsonRequest(`/api/allocations/runs/${previewId}/post`, "POST", { reason: "month-end" }),
      { params: Promise.resolve({ id: previewId }) },
    );
    assert.equal(posted.status, 200);
    assert.ok(((await posted.json()) as { journalEntryId: string }).journalEntryId);

    const reversed = await reverseRoute.POST(
      jsonRequest(`/api/allocations/runs/${previewId}/reverse`, "POST", {
        reason: "correction",
        reversalDate: s.postingDate,
      }),
      { params: Promise.resolve({ id: previewId }) },
    );
    assert.equal(reversed.status, 200);
    assert.ok(((await reversed.json()) as { reversalEntryId: string }).reversalEntryId);

    // Nothing changed since the reversal: the re-run is idempotent and posts
    // nothing new — same run id back.
    const reran = await rerunRoute.POST(
      // The Runs tab posts `{}` for a one-click re-run; the shared JSON
      // boundary requires an object body even when every field is optional.
      jsonRequest(`/api/allocations/runs/${previewId}/rerun`, "POST", {}),
      { params: Promise.resolve({ id: previewId }) },
    );
    assert.equal(reran.status, 200);
    assert.equal(((await reran.json()) as { runId: string }).runId, previewId);
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
