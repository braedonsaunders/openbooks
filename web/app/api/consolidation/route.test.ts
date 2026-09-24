import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The close task persists an engine refusal inline and maps its code, so the
// route must answer a typed {error, code} pair with 422 — never a bare
// status the UI cannot map. This drives the real route against a real
// ownership-coverage gap (same fixture shape as
// engine/src/consolidation/ownership-gap.integration.test.ts): only the
// session/feature boundary is stubbed, the engine, validation, and storage
// are real.

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const stateKey = Symbol.for("openbooks.consolidation-route-test");
const state: { user: { id: string; orgId: string } } = {
  user: { id: "user-1", orgId: "org-1" },
};
(globalThis as Record<symbol, unknown>)[stateKey] = state;

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    // Session/feature boundary only: every other module (validation, the
    // consolidation engine, storage) loads for real.
    if (specifier === "@/lib/authz")
      return { shortCircuit: true, url: "mock:consolidation-authz" };
    if (specifier === "../../../lib/feature-gates")
      return { shortCircuit: true, url: "mock:consolidation-gates" };
    if (specifier === "@/lib/api/json")
      return next(
        new URL("../../../lib/api/json.ts", import.meta.url).href,
        context,
      );
    if (specifier === "../../../lib/list-params")
      return next(
        new URL("../../../lib/list-params.ts", import.meta.url).href,
        context,
      );
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:consolidation-authz")
      return {
        shortCircuit: true,
        format: "module",
        source: `export function guardSubsidiaryScope() { return null }`,
      };
    if (url === "mock:consolidation-gates")
      return {
        shortCircuit: true,
        format: "module",
        source: `const state = globalThis[Symbol.for('openbooks.consolidation-route-test')]
          export async function guardFeaturePermission() { return { user: state.user } }`,
      };
    return next(url, context);
  },
});
const routeUrl = "./route.ts?consolidation-route";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;

// Same gap shape as the engine-level fixture: policy A covers July 1-29,
// policy B starts July 31 for the SAME acquisition — July 30 belongs to no
// policy, so the ownership run must refuse instead of consolidating 30 of
// 31 days.
async function seedGapFixture(org: ScratchOrg): Promise<void> {
  const childId = randomUUID();
  const eliminationId = randomUUID();
  await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Owned Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Ownership eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
  const defs = [
    ["investment", "1400", "Investment in subsidiary", "asset_current_other"],
    ["equityIncome", "4020", "Equity income", "income_other"],
    ["nciEquity", "3100", "Non-controlling interest", "equity"],
    ["nciIncome", "6100", "Profit attributable to NCI", "expense_other"],
    ["goodwill", "1500", "Goodwill", "asset_fixed"],
    ["fairValue", "1510", "Fair value adjustment", "asset_fixed"],
    ["childEquity", "3000", "Child share capital", "equity"],
  ] as const;
  const accounts = new Map<string, string>();
  for (const [key, number, name, type] of defs) {
    const id = randomUUID();
    accounts.set(key, id);
    await db.execute(sql`
        insert into accounts
          (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${id},${org.orgId},${number},${name},${type},false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)
      `);
  }
  const postEntry = async (tag: string, date: string, revenue: string): Promise<void> => {
    const entry = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values (${entry},${org.orgId},${org.bookId},${childId},${tag},${date},${org.periodId},${tag},'draft','manual')`);
    await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${entry},1,${org.accounts.bank},${childId},${revenue},'CAD',${revenue},'1'),
        (${org.orgId},${entry},2,${org.accounts.revenue},${childId},${`-${revenue}`},'CAD',${`-${revenue}`},'1')`);
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
  };
  const capId = randomUUID();
  await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values (${capId},${org.orgId},${org.bookId},${childId},'OWN-CAP','2026-07-01',${org.periodId},'OWN-CAP','draft','manual')`);
  await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capId},1,${org.accounts.bank},${childId},'1000','CAD','1000','1'),
        (${org.orgId},${capId},2,${accounts.get("childEquity")!},${childId},'-1000','CAD','-1000','1')`);
  await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${capId}`);
  await postEntry("OWN-PROFIT-COVERED", "2026-07-15", "100");
  await postEntry("OWN-PROFIT-GAP", "2026-07-30", "100");
  const policy = (id: string, from: string, to: string | null): Promise<unknown> => db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,effective_to,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${id},${org.orgId},${org.subsidiaryId},${childId},${from},${to},'80','full',
              '2026-07-01','900','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},${accounts.get("nciEquity")!},${accounts.get("nciIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})`);
  await policy(randomUUID(), "2026-07-01", "2026-07-29");
  await policy(randomUUID(), "2026-07-31", null);
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/consolidation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "an ownership-coverage gap answers 422 with the typed code, not a bare status",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await seedGapFixture(org);
      state.user = { id: randomUUID(), orgId: org.orgId };

      const response = await POST(
        postRequest({ action: "ownership", periodId: org.periodId }),
      );

      assert.equal(response.status, 422);
      const body = (await response.json()) as { error?: string; code?: string };
      assert.equal(body.code, "ownership-gap");
      assert.match(
        body.error ?? "",
        /ownership coverage for Owned Co has a gap: the policy ending 2026-07-29.*2026-07-31/,
        "the message names the subsidiary and the gap edges so the close task can persist it",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an unknown action is a 400 through the real body validation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    state.user = { id: randomUUID(), orgId: org.orgId };

    const response = await POST(
      postRequest({ action: "OWN EVERYTHING", periodId: org.periodId }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "periodId and action (derive-rates|ownership|eliminate|consolidate) required",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
