import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Bank-rule creation/update passes priority through Number() straight into
 * the integer column with no try/catch on either verb, so an out-of-int32
 * figure dies in Postgres as a raw integer failure (HTTP 500) instead of
 * failing closed with a named error and nothing written.
 * bank_match_rules.priority is integer DEFAULT 100 NOT NULL.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __bankRulePriorityState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__bankRulePriorityState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

const CRITERIA = {
  version: 2,
  match: { combinator: "and", rules: [{ field: "description", op: "contains", value: "TIM HORTONS" }] },
};
const OUTCOME = { action: "exclude" };

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  return { org };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://bank.test/api/banking/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function ruleCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from bank_match_rules where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("bank-rule creation refuses an out-of-int32 priority without writing", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post({ name: "Probe rule", criteria: CRITERIA, outcome: OUTCOME, priority: 99999999999999999999 });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.notEqual(response.status, 500, `expected a named error, got 500: ${JSON.stringify(json)}`);
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await ruleCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("bank-rule creation still files an ordinary priority", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post({ name: "Probe rule", criteria: CRITERIA, outcome: OUTCOME, priority: 50 });
    const json = (await response.json().catch(() => null)) as { id?: string } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(await ruleCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
