import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-bank-file-scope")] = state;
// The route imports the JSON boundary through the web `@/` alias, which tsx
// resolves only under the web tsconfig. Map it to the real module so the
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
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "@/lib/api/json") return { shortCircuit: true, url: apiJsonUrl };
  if (specifier === "../../../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/bank-file/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-bank-file-scope')].gate}") };
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
const { db } = await import("@openbooks/engine/src/db.ts");
const { seedAdoption, calculatedRun } = await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { commitPayRun } = await import("@openbooks/engine/src/payroll-run.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { GET, POST } = await import("../app/api/payroll/runs/[id]/bank-file/route");

/**
 * The bank-file panel and generator enforce the run-population scope the
 * run detail and every other run action enforce: a run whose legal entity
 * is visible but which carries an employee outside the caller's subsidiary
 * scope is opaque — its panel is a 404 and generating its file is refused.
 */
async function opaqueFixture() {
  const fx = await seedAdoption();
  await db.execute(sql`update parties set subsidiary_id = ${fx.subsidiaryId}
    where org_id = ${fx.orgId} and id = ${fx.employeeId}`);
  const { input } = await calculatedRun(fx);
  await commitPayRun(input);
  const hidden = randomUUID();
  await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${hidden}, ${fx.orgId}, ${fx.subsidiaryId}, 'Hidden payroll employer', 'CAD', 'CA')`);
  await db.execute(sql`update parties set subsidiary_id = ${hidden}
    where org_id = ${fx.orgId} and id = ${fx.employeeId}`);
  return { fx, documentId: input.documentId };
}

function scopedGate(fx: { orgId: string; actorId: string; subsidiaryId: string }, permission: string): Authz {
  return {
    user: { orgId: fx.orgId, id: fx.actorId },
    permissions: new Set([permission]),
    allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
  } as Authz;
}

test("bank-file panel hides a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { fx, documentId } = await opaqueFixture();
  try {
    state.gate = scopedGate(fx, "payroll.read");
    const refused = await GET(
      new Request("https://openbooks.test/api/payroll/runs/fixture/bank-file"),
      { params: Promise.resolve({ id: documentId }) },
    );
    assert.equal(refused.status, 404, JSON.stringify(await refused.clone().json()));
    assert.deepEqual(await refused.json(), { error: "not found" });

    state.gate = { ...scopedGate(fx, "payroll.read"), allowedSubsidiaryIds: null };
    const visible = await GET(
      new Request("https://openbooks.test/api/payroll/runs/fixture/bank-file"),
      { params: Promise.resolve({ id: documentId }) },
    );
    assert.equal(visible.status, 200, JSON.stringify(await visible.clone().json()).slice(0, 300));
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("bank-file generate refuses a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { fx, documentId } = await opaqueFixture();
  try {
    state.gate = scopedGate(fx, "payroll.run");
    const refused = await POST(
      new Request("https://openbooks.test/api/payroll/runs/fixture/bank-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentBankProfileId: randomUUID() }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    assert.equal(refused.status, 409, JSON.stringify(await refused.clone().json()));
    assert.match(String((await refused.json() as { error: string }).error), /pay run not found/);
    const artifacts = (await db.execute<{ count: string }>(sql`
      select count(*) as count from pay_run_bank_files
       where org_id = ${fx.orgId} and pay_run_document_id = ${documentId}`)).rows[0]!.count;
    assert.equal(artifacts, "0", "a refused generate must not leave a bank-file artifact behind");
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});
