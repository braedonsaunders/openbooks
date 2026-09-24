import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// H-CREWPOST sweep: POST /api/banking/statement-lines/[id]/create-match
// (and the rule-apply routes) gate only banking.reconcile, but matching a
// line with a new journal posts that journal to the GL through
// createCategorizingJournal. A banking.reconcile-only preparer must get the
// named gl.post refusal before any document, submission, or posting write;
// a gl.post holder matches exactly as before. Only the feature gate is
// doubled; the route, the journal service, and Postgres are real.
const root = pathToFileURL(process.cwd() + "/").href;
const state: { orgId: string; actorId: string; allowedSubsidiaryIds: Set<string> | null } = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null,
};
Object.assign(globalThis, { __bankingMatchScopeState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    // The route imports the gate by relative path (not the @/ alias), so
    // match its exact specifier; everything else resolves for real.
    if (specifier === "../../../../../../lib/feature-gates") return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__bankingMatchScopeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: s.allowedSubsidiaryIds };
      }
    `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { ensureOpenReconciliation } = await import("@/lib/banking-rules");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  lineId: string;
  reconId: string;
  offsetAccountId: string;
}

async function grant(orgId: string, userId: string, permission: string): Promise<void> {
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${orgId}, ${userId}, ${permission}, 'grant')
    on conflict (user_id, permission) do update set effect = 'grant'
  `);
}

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Bank Preparer", "bank_preparer");
  await grant(org.orgId, actorId, "banking.reconcile");
  const bankId = org.accounts.bank;
  await withBypassContext(async () => db.execute(sql`
    update accounts set reconcilable = true, currency_restriction = 'CAD', subsidiary_id = ${org.subsidiaryId}
     where id in (${bankId}, ${org.accounts.revenue}) and org_id = ${org.orgId}
  `));
  const statementId = randomUUID();
  await withBypassContext(async () => db.execute(sql`
    insert into bank_statements (id, org_id, account_id, source, statement_date, closing_balance, raw_file_ref)
    values (${statementId}, ${org.orgId}, ${bankId}, 'scope-fixture', ${org.date}, '1000.0000', 'scope-fixture.raw')
  `));
  const lineId = randomUUID();
  await withBypassContext(async () => db.execute(sql`
    insert into bank_statement_lines
      (id, org_id, statement_id, line_number, posted_on, amount, currency, description, match_status, account_id)
    values (${lineId}, ${org.orgId}, ${statementId}, 1, ${org.date}, '1000.0000', 'CAD', 'Scope deposit', 'unmatched', ${bankId})
  `));
  const reconId = await withBypassContext(() => ensureOpenReconciliation(org.orgId, actorId, bankId, null));
  state.orgId = org.orgId;
  state.actorId = actorId;
  state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
  return { orgId: org.orgId, actorId, lineId, reconId, offsetAccountId: org.accounts.revenue };
}

async function post(lineId: string, reconId: string, offsetAccountId: string) {
  try {
    const response: Response = await withOrgContext(state.orgId, () => POST(
      new Request(`http://banking.test/api/banking/statement-lines/${lineId}/create-match`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reconciliationId: reconId, offsetAccountId }),
      }),
      { params: Promise.resolve({ id: lineId }) },
    ));
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> };
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } };
  }
}

async function journalCount(orgId: string): Promise<number> {
  return (await withOrgContext(orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents where org_id = ${orgId} and kind = 'journal'`))).rows[0]!.n;
}

async function lineStatus(orgId: string, lineId: string): Promise<string | null> {
  const rows = (await withOrgContext(orgId, () => db.execute<{ match_status: string }>(sql`
    select match_status from bank_statement_lines where org_id = ${orgId} and id = ${lineId}`))).rows;
  return rows[0]?.match_status ?? null;
}

test("a banking.reconcile-only preparer is refused before any journal write", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const denied = await post(f.lineId, f.reconId, f.offsetAccountId);
    assert.equal(denied.status, 403, `expected 403, got ${denied.status}: ${JSON.stringify(denied.json)}`);
    assert.match(String(denied.json.error), /gl\.post/);
    assert.equal(await journalCount(f.orgId), 0, "refused match must write no journal");
    assert.equal(await lineStatus(f.orgId, f.lineId), "unmatched", "refused line stays unmatched");
  } finally {
    await withBypassContext(() => dropScratchOrg(f.orgId));
  }
});

test("a gl.post holder matches exactly as before", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await grant(f.orgId, f.actorId, "gl.post");
    const matched = await post(f.lineId, f.reconId, f.offsetAccountId);
    assert.equal(matched.status, 200, `expected 200, got ${matched.status}: ${JSON.stringify(matched.json)}`);
    assert.equal(await journalCount(f.orgId), 1, "allowed match posts exactly one journal");
    assert.equal(await lineStatus(f.orgId, f.lineId), "matched", "allowed line matches");
  } finally {
    await withBypassContext(() => dropScratchOrg(f.orgId));
  }
});
