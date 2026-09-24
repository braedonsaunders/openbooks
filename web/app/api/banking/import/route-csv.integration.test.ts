import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

/**
 * Real-CSV coverage for the banking import API: the mocked route test pins
 * modes and plumbing with a stubbed parser, so a regression in parseCsv's
 * first-row classification (header warned, disclaimer dropped, preamble
 * refused, transaction row skipped) would stay green there. These tests
 * upload real CSV text through the production route with only the
 * permission/feature gate stubbed — parsing, validation, and the engine
 * import run for real against a scratch org.
 */
const stateKey = Symbol.for("openbooks.bank-import-csv-route-test");
const routeState: { orgId: string; actorId: string } = { orgId: "", actorId: "" };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.bank-import-csv-route-test')]
  export async function guardFeaturePermission() {
    return { user: { orgId: state.orgId, id: state.actorId } }
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier === "../../../../lib/feature-gates") {
      return { url: "mock:bank-import-csv-feature-gates", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:bank-import-csv-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?bank-import-csv-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;
const MAPPING = { date: 0, amount: 1, description: 2 };

async function fixture() {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  routeState.orgId = org.orgId;
  routeState.actorId = actor;
  await db.execute(sql`
    update accounts
       set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  return { org, actor };
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(routeState.orgId, () =>
    POST(
      new Request("http://openbooks.test/api/banking/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
  // Read as text first: the payload is asserted structurally below, and a
  // status failure must still show the body instead of losing it to a
  // second read.
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { unparseable: text };
  }
  return { status: response.status, json };
}

function csvBody(accountId: string, text: string, mode: "preview" | "import") {
  return { accountId, source: "csv", text, mapping: MAPPING, mode };
}

async function storedLineCount(orgId: string, accountId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from bank_statement_lines
     where org_id = ${orgId} and account_id = ${accountId}`)).rows;
  return rows[0]!.n;
}

test(
  "a plain column-header row previews with no skipped warning",
  { skip: !DB },
  async () => {
    const { org } = await fixture();
    try {
      const { status, json } = await post(
        csvBody(
          org.accounts.bank,
          "Date,Amount,Description\n2026-07-01,12.50,salary\n2026-07-02,-5.00,coffee\n",
          "preview",
        ),
      );
      assert.equal(status, 200, `expected 200: ${JSON.stringify(json)}`);
      const body = json as {
        imported: number;
        skipped: unknown[];
      };
      assert.equal(body.imported, 2);
      assert.deepEqual(body.skipped, []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a leading disclaimer row previews reported by code, never dropped",
  { skip: !DB },
  async () => {
    const { org } = await fixture();
    try {
      const { status, json } = await post(
        csvBody(
          org.accounts.bank,
          "Bank export - confidential\n2026-07-01,12.50,salary\n",
          "preview",
        ),
      );
      assert.equal(status, 200, `expected 200: ${JSON.stringify(json)}`);
      const body = json as {
        imported: number;
        skipped: unknown[];
      };
      assert.equal(body.imported, 1);
      assert.deepEqual(body.skipped, [
        { line: 1, code: "csv_metadata_row", dateCell: "Bank export - confidential" },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a metadata preamble before the header imports data with each disclaimer reported",
  { skip: !DB },
  async () => {
    const { org } = await fixture();
    try {
      const { status, json } = await post(
        csvBody(
          org.accounts.bank,
          "Bank export - confidential\nGenerated 2026-07-01\nDate,Amount,Description\n2026-07-01,12.50,salary\n2026-07-02,-5.00,coffee\n",
          "import",
        ),
      );
      assert.equal(status, 200, `expected 200: ${JSON.stringify(json)}`);
      const body = json as {
        imported: number;
        skipped: unknown[];
        statementId: string | null;
      };
      assert.ok(body.statementId, "the preamble import must persist a statement");
      assert.equal(body.imported, 2);
      assert.deepEqual(body.skipped, [
        { line: 1, code: "csv_metadata_row", dateCell: "Bank export - confidential" },
        { line: 2, code: "csv_metadata_row", dateCell: "Generated 2026-07-01" },
      ]);
      assert.equal(await storedLineCount(org.orgId, org.accounts.bank), 2);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a transaction-looking first row is refused by name with nothing written",
  { skip: !DB },
  async () => {
    const { org } = await fixture();
    try {
      const { status, json } = await post(
        csvBody(
          org.accounts.bank,
          "oops,12.50,salary\n2026-07-01,5.00,coffee\n",
          "import",
        ),
      );
      assert.equal(status, 422, `expected 422: ${JSON.stringify(json)}`);
      const body = json as { error: string };
      assert.match(body.error, /CSV row 1 looks like a transaction/);
      assert.match(body.error, /remove the row|fix the date/);
      assert.equal(await storedLineCount(org.orgId, org.accounts.bank), 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
