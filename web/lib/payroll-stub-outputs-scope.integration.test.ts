import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null; reportResolutions: number } = { gate: null, reportResolutions: 0 };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-stub-outputs-scope")] = state;
// The run route imports the JSON boundary through the web `@/` alias, which
// tsx resolves only under the web tsconfig. Map it to the real module so the
// route under test runs its production body parsing.
const apiJsonUrl = new URL("./api/json.ts", import.meta.url).href;
// Fleet worktrees symlink node_modules (and web/node_modules) at the main
// checkout, so a bare `@openbooks/engine/...` import inside web code
// resolves to the MAIN checkout's engine — the behaviour under test would
// be main's, not this worktree's, and `instanceof` checks would span two
// module instances. Rewrite every main-checkout source URL to this
// worktree so the route and the engine it calls are one codebase.
// (Symlinked node_modules paths rewrite onto themselves and are harmless.)
const MAIN_ROOT_URL = "file:///Users/braedonsaunders/Documents/openbooks/";
const WORKTREE_ROOT_URL = new URL("../../", import.meta.url).href;
const gateMock = "data:text/javascript," + encodeURIComponent(
  "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-stub-outputs-scope')].gate}");
// documents/actions authenticates through lib/authz, which reads cookies —
// unmockable headless. The mock returns the test gate, grants the document
// permission, and enforces the same subsidiary rule as the real guard so the
// run-subsidiary gate is genuinely exercised on the way to the evidence.
const authzMock = "data:text/javascript," + encodeURIComponent(`
  export async function getAuthz() { return globalThis[Symbol.for('openbooks.payroll-stub-outputs-scope')].gate; }
  export function can() { return true; }
  export function guardSubsidiaryScope(gate, subsidiaryId) {
    if (gate.allowedSubsidiaryIds === null || gate.allowedSubsidiaryIds === undefined) return null;
    if (subsidiaryId && gate.allowedSubsidiaryIds.has(subsidiaryId)) return null;
    return Response.json({ error: 'not found' }, { status: 404 });
  }
`);
// resolveDefinitionToExportData requires a Next request scope (report authz
// reads cookies), which no harness has. The translator-style stub records
// each resolution and returns empty-but-valid report content: the defect
// under test is the missing population gate BEFORE any report is resolved,
// and the report contents themselves are covered by the report suite.
const reportRunMock = "data:text/javascript," + encodeURIComponent(`
  export async function resolveDefinitionToExportData() {
    const state = globalThis[Symbol.for('openbooks.payroll-stub-outputs-scope')];
    state.reportResolutions += 1;
    return { title: 'mock-evidence', dateRangeLabel: '', summary: [], groups: [] };
  }
`);
const nextIntlMock = "data:text/javascript," + encodeURIComponent(
  "export async function getTranslations(){return ((key) => key)}");
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next-intl/server") return { shortCircuit: true, url: nextIntlMock };
  if (specifier === "@/lib/api/json") return { shortCircuit: true, url: apiJsonUrl };
  const parent = decodeURIComponent(context.parentURL ?? "");
  if (specifier === "./report-run" && parent.endsWith("/web/lib/payroll-evidence.ts")) {
    return { shortCircuit: true, url: reportRunMock };
  }
  if (specifier === "../../../../lib/authz"
    && parent.endsWith("/api/documents/actions/route.ts")) {
    return { shortCircuit: true, url: authzMock };
  }
  if (specifier === "../../../../../../lib/feature-gates"
    && parent.endsWith("/api/payroll/runs/[id]/stubs-pdf/route.ts")) {
    return { shortCircuit: true, url: gateMock };
  }
  if (specifier === "../../../../../lib/feature-gates"
    && parent.endsWith("/api/payroll/runs/[id]/route.ts")) {
    return { shortCircuit: true, url: gateMock };
  }
  const resolved = next(specifier, context);
  const rewrite = (url: string) =>
    url.startsWith(MAIN_ROOT_URL) ? WORKTREE_ROOT_URL + url.slice(MAIN_ROOT_URL.length) : url;
  if (resolved.url.startsWith(MAIN_ROOT_URL)) {
    return { url: rewrite(resolved.url), shortCircuit: true };
  }
  return resolved;
} });
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { seedAdoption, calculatedRun } = await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
const { commitPayRun } = await import("@openbooks/engine/src/payroll/run.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { GET: stubsPdf } = await import("../app/api/payroll/runs/[id]/stubs-pdf/route");
const { POST: runAction } = await import("../app/api/payroll/runs/[id]/route");
const { POST: documentAction } = await import("../app/api/documents/actions/route");

/**
 * Stub outputs carry every employee's wage data, so they enforce the same
 * run-population opacity as the run detail: a run whose legal entity is
 * visible but which carries an employee outside the caller's subsidiary
 * scope is opaque — its stub PDF is a 404 and emailing its stubs is refused.
 */
async function opaqueFixture() {
  const fx = await withBypassContext(() => seedAdoption());
  await withBypassContext(() => db.execute(sql`update parties set subsidiary_id = ${fx.subsidiaryId}
    where org_id = ${fx.orgId} and id = ${fx.employeeId}`));
  const { input } = await withBypassContext(() => calculatedRun(fx));
  await withOrgContext(fx.orgId, () => commitPayRun(input));
  const hidden = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${hidden}, ${fx.orgId}, ${fx.subsidiaryId}, 'Hidden stub employer', 'CAD', 'CA')`));
  await withBypassContext(() => db.execute(sql`update parties set subsidiary_id = ${hidden}
    where org_id = ${fx.orgId} and id = ${fx.employeeId}`));
  return { fx, documentId: input.documentId };
}

function scopedGate(fx: { orgId: string; actorId: string; subsidiaryId: string }, permission: string): Authz {
  return {
    user: { orgId: fx.orgId, id: fx.actorId },
    permissions: new Set([permission]),
    allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
  } as Authz;
}

test("stub PDF hides a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { fx, documentId } = await opaqueFixture();
  try {
    state.gate = scopedGate(fx, "payroll.read");
    const refused = await withOrgContext(fx.orgId, () => stubsPdf(
      new Request("https://openbooks.test/api/payroll/runs/fixture/stubs-pdf"),
      { params: Promise.resolve({ id: documentId }) },
    ));
    // The body is a PDF on the leak path, so peek as text: parsing it as
    // JSON would throw instead of reporting the 200.
    const refusedBody = await refused.clone().text();
    assert.equal(refused.status, 404, JSON.stringify(refusedBody.slice(0, 200)));
    assert.deepEqual(JSON.parse(refusedBody), { error: "not found" });

    // The run IS printable: the unrestricted control receives the stub PDF,
    // proving the scoped refusal above is the population check at work.
    state.gate = { ...scopedGate(fx, "payroll.read"), allowedSubsidiaryIds: null };
    const control = await withOrgContext(fx.orgId, () => stubsPdf(
      new Request("https://openbooks.test/api/payroll/runs/fixture/stubs-pdf"),
      { params: Promise.resolve({ id: documentId }) },
    ));
    assert.equal(control.status, 200);
    assert.match(
      control.headers.get("content-type") ?? "",
      /pdf/,
      "the unrestricted control receives the stub PDF",
    );
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("stub email refuses a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { fx, documentId } = await opaqueFixture();
  try {
    state.gate = scopedGate(fx, "payroll.run");
    const refused = await withOrgContext(fx.orgId, () => runAction(
      new Request("https://openbooks.test/api/payroll/runs/fixture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "email-stubs" }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    ));
    assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()));
    assert.match(String((await refused.json() as { error: string }).error), /pay run not found/);
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("approval submission refuses a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { fx, documentId } = await opaqueFixture();
  try {
    // The evidence package (journal + register + GL preview) names every
    // employee's pay, so submitting it for an opaque run must fail closed
    // before a single report is resolved — like the GL preview action does.
    state.gate = scopedGate(fx, "payroll.run");
    state.reportResolutions = 0;
    const refused = await withOrgContext(fx.orgId, () => runAction(
      new Request("https://openbooks.test/api/payroll/runs/fixture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit-approval" }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    ));
    assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()).slice(0, 300));
    assert.match(String((await refused.json() as { error: string }).error), /pay run not found/);
    assert.equal(state.reportResolutions, 0, "a refused submission must resolve no evidence report");

    state.gate = { ...scopedGate(fx, "payroll.run"), allowedSubsidiaryIds: null };
    const submitted = await withOrgContext(fx.orgId, () => runAction(
      new Request("https://openbooks.test/api/payroll/runs/fixture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit-approval" }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    ));
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()).slice(0, 300));
    assert.ok(state.reportResolutions > 0, "the unrestricted control assembles evidence");
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

/** An on_submit pay-run flow with a gate — a real approval policy, so the
document submit path assembles evidence. */
const GATING_GRAPH = {
  schemaVersion: 1,
  nodes: [
    { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
    {
      id: "g", position: { x: 200, y: 0 },
      data: {
        kind: "gate",
        gate: { title: "Approve pay run", assignees: [{ kind: "role", role: "admin" }], mode: "any" },
      },
    },
  ],
  edges: [{ id: "e", source: "t", target: "g" }],
};

test("document submit refuses evidence assembly for a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // The generic document submit attaches the same evidence package when the
  // org gates pay runs — through a second route that must enforce the same
  // population opacity. A calculated (still draft-document) run assembles.
  const fx = await withBypassContext(() => seedAdoption());
  await withBypassContext(() => db.execute(sql`update parties set subsidiary_id = ${fx.subsidiaryId}
    where org_id = ${fx.orgId} and id = ${fx.employeeId}`));
  const { input } = await withBypassContext(() => calculatedRun(fx));
  await withBypassContext(() => db.execute(sql`
    insert into flows (org_id, name, subject_kind, enabled, graph, created_by, updated_by)
    values (${fx.orgId}, 'Pay run approval', 'pay_run', true,
            ${JSON.stringify(GATING_GRAPH)}::jsonb, ${fx.actorId}, ${fx.actorId})`));
  const hidden = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${hidden}, ${fx.orgId}, ${fx.subsidiaryId}, 'Hidden submit employer', 'CAD', 'CA')`));
  await withBypassContext(() => db.execute(sql`update parties set subsidiary_id = ${hidden}
    where org_id = ${fx.orgId} and id = ${fx.employeeId}`));
  try {
    state.gate = scopedGate(fx, "payroll.run");
    state.reportResolutions = 0;
    const refused = await withOrgContext(fx.orgId, () => documentAction(
      new Request("https://openbooks.test/api/documents/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", documentId: input.documentId }),
      }),
    ));
    assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()).slice(0, 300));
    assert.match(String((await refused.json() as { error: string }).error), /pay run not found/);
    assert.equal(state.reportResolutions, 0, "a refused submission must resolve no evidence report");

    state.gate = { ...scopedGate(fx, "payroll.run"), allowedSubsidiaryIds: null };
    const submitted = await withOrgContext(fx.orgId, () => documentAction(
      new Request("https://openbooks.test/api/documents/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", documentId: input.documentId }),
      }),
    ));
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()).slice(0, 300));
    assert.ok(state.reportResolutions > 0, "the unrestricted control assembles evidence");
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});
