import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../money-server" && context.parentURL?.includes("/analytics/")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}" };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { add } = await import("@openbooks/engine/src/money/money.ts");
const { db, withOrgContext, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { healthData } = await import("./analytics/health-data");
const { customerData, customerProfitability } = await import("./analytics/customer-data");
const { profitAndLoss } = await import("./reports/statements");

for (const view of ["current month", "completed month", "segments", "drivers", "items", "operating income"] as const) {
  test(`Financial Health reconciles ${view} to the primary posted ledger`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const taxBook = randomUUID();
      const department = randomUUID();
      const otherIncome = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
          values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
        await db.execute(sql`insert into departments(id,org_id,name) values (${department},${org.orgId},'Operations')`);
        await db.execute(sql`insert into accounts(id,org_id,number,name,type)
          values (${otherIncome},${org.orgId},'4999','Nonoperating income','income_other')`);
        for (const [book, status, amount, account] of [
          [org.bookId, 'posted', '100', org.accounts.revenue],
          [org.bookId, 'posted', '50', otherIncome],
          [taxBook, 'posted', '700', org.accounts.revenue],
          [org.bookId, 'draft', '900', org.accounts.revenue],
        ]) {
          const entry = randomUUID();
          await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
            values (${entry},${org.orgId},${book},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual')`);
          await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,location_id,amount,currency,txn_amount,fx_rate)
            values (${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${department},${org.locationId},${amount},'CAD',${amount},1),
            (${org.orgId},${entry},2,${account},${org.subsidiaryId},${department},${org.locationId},${'-' + amount},'CAD',${'-' + amount},1)`);
          if (status === 'posted') await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
        }
      });
      await withOrgContext(org.orgId, async () => {
        const to = view === "completed month" ? "2026-08-15" : org.date;
        const result = await healthData({ from: "2026-07-01", to, label: "Ledger review" }, org.orgId, null);
        assert.equal(result.figures.revenue, "150.0000", "primary-book headline control");
        assert.equal(result.figures.operatingIncome, "100.0000", "nonoperating income excluded in headline");
        let running = "0";
        // buildMarginFlow always emits the nine waterfall stages: the
        // per-stage reconciliation below cannot pass over an empty flow.
        assert.ok(result.marginFlow.length > 0, "margin waterfall must carry stages");
        for (const stage of result.marginFlow) {
          if (stage.kind === "start") running = stage.amount;
          else if (stage.kind === "deduct") running = add(running, stage.amount);
          else assert.equal(stage.amount, running, `${stage.label} reconciles to posted history`);
        }
        const month = result.monthly.find(row => row.month === '2026-07');
        assert.ok(month);
        if (view === "current month" || view === "completed month") assert.equal(month.revenue, '150.0000');
        if (view === "segments") {
          assert.equal(result.segments.department.find(row => row.id === department)?.revenue, '150.0000');
          assert.equal(result.segments.location.find(row => row.id === org.locationId)?.revenue, '150.0000');
        }
        if (view === "drivers") assert.equal(result.drivers.revenue.find(row => row.id === org.accounts.revenue)?.current, '100.0000');
        if (view === "items") {
          assert.equal(result.items.totalCurrent, '150.0000');
          assert.equal(result.items.rows.find(row => row.id === org.accounts.revenue)?.current, '100.0000');
        }
        if (view === "operating income") {
          assert.equal(month.operatingIncome, '100.0000');
          assert.equal(month.netIncome, '150.0000');
          assert.equal(result.segments.department.find(row => row.id === department)?.operatingIncome, '100.0000');
        }
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}

const headcountCases = [{ label: "health-headcount", register: async () => {
const { financialHealth } = await import("./analytics/financial-health");

const cases = [
  { name: "active employee", hired: "2026-01-01", terminated: null, expected: 1 },
  { name: "future hire", hired: "2026-08-01", terminated: null, expected: 0 },
  { name: "later termination", hired: "2026-01-01", terminated: "2026-08-01", expected: 1 },
  { name: "termination on cutoff", hired: "2026-01-01", terminated: "2026-07-31", expected: 1 },
  { name: "earlier termination", hired: "2026-01-01", terminated: "2026-07-30", expected: 0 },
  { name: "undated employee", hired: null, terminated: null, expected: 1 },
];
for (const scenario of cases) {
  test(`Financial Health period-end headcount: ${scenario.name}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const employee = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
          values (${employee},${org.orgId},'person','Historical employee',${org.subsidiaryId})`);
        await db.execute(sql`insert into employee_roles(org_id,party_id,hired_on,terminated_on)
          values (${org.orgId},${employee},${scenario.hired},${scenario.terminated})`);
      });
      await withOrgContext(org.orgId, async () => {
        const data = await financialHealth({ from: "2026-07-01", to: "2026-07-31", label: "July" }, org.orgId, null);
        assert.equal(data.figures.headcount, scenario.expected);
        for (const key of ["rev_per_employee", "gp_per_employee"]) {
          const ratio = Object.values(data.ratios).flat().find(row => row.id === key);
          assert.ok(ratio);
          assert.equal(ratio.value, scenario.expected ? "0.0000" : null);
          assert.equal(ratio.unavailable !== null, scenario.expected === 0);
        }
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}
}}] as const; for (const row of headcountCases) await row.register();

const pnlUniverseCases = [{ label: "analytics-pnl-universe", register: async () => {
// An expense_other posting carrying a department tag and a project tag must
// move the Health segment breakdown and Customer profitability, and the
// project slice must tie to the headline P&L.
//
test('expense_other with segment + project tags reaches every P&L slice', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Single-file runs do not have the suite's bypass wrapper: fixture
  // create/remove and every seed run inside withBypassContext, while reads
  // through the web readers run inside withOrgContext.
  const org = await withBypassContext(async () => {
    const scoped = await createScratchOrg();
    const deptA = randomUUID();
    const deptB = randomUUID();
    const otherExpense = randomUUID();
    const project = randomUUID();
    await db.execute(sql`insert into departments(id,org_id,name) values (${deptA},${scoped.orgId},'Sales'),(${deptB},${scoped.orgId},'Field')`);
    await db.execute(sql`insert into accounts(id,org_id,number,name,type)
        values (${otherExpense},${scoped.orgId},'7050','Other Expense','expense_other')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
        values (${project},${scoped.orgId},${scoped.subsidiaryId},'PNL','P&L project',${scoped.customerId},'active',true)`);
    // entry(dept, debitAccount, debitAmount, creditAccount, creditAmount):
    // every leg carries the department and the project tag.
    async function post(dept: string, debitAccount: string, debit: string, creditAccount: string, credit: string) {
      const entry = randomUUID();
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
          values (${entry},${scoped.orgId},${scoped.bookId},${scoped.subsidiaryId},${entry},${scoped.date},${scoped.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,project_id,party_id,amount,currency,txn_amount,fx_rate)
          values (${scoped.orgId},${entry},1,${debitAccount},${scoped.subsidiaryId},${dept},${project},${scoped.vendorId},${debit},'CAD',${debit},1),
          (${scoped.orgId},${entry},2,${creditAccount},${scoped.subsidiaryId},${dept},${project},${scoped.vendorId},${credit},'CAD',${credit},1)`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
    }
    // Dept A: revenue 200 with an expense_other cost of 60.
    await post(deptA, scoped.accounts.bank, '200', scoped.accounts.revenue, '-200');
    await post(deptA, otherExpense, '60', scoped.accounts.bank, '-60');
    // Dept B: an expense_other cost of 40 and nothing else — pre-fix this
    // segment vanishes entirely through the breakdown HAVING clause.
    await post(deptB, otherExpense, '40', scoped.accounts.bank, '-40');
    return { scoped, deptA, deptB };
  });
  try {
    await withOrgContext(org.scoped.orgId, async () => {
      const period = { from: '2026-07-01', to: org.scoped.date, label: 'P&L universe review' };
      const headline = await profitAndLoss(period.from, period.to, undefined, org.scoped.orgId);
      assert.equal(Number(headline.revenue), 200, 'headline control: revenue');
      assert.equal(Number(headline.expenses), 100, 'headline control: expenses include expense_other');
      const loader = await customerData(period, org.scoped.orgId, null);
      const profit = await customerProfitability(period, org.scoped.orgId, null, undefined, loader.kpis.totalRevenue);
      assert.equal(profit.summary.totalRevenue, '200.0000');
      assert.equal(profit.summary.totalCost, '100.0000', 'project costs include expense_other legs');
      assert.equal(profit.summary.totalGrossProfit, '100.0000', 'project slice ties to the headline P&L');
      const health = await healthData(period, org.scoped.orgId, null);
      const segA = health.segments.department.find((row) => row.id === org.deptA);
      assert.ok(segA, 'segment with revenue is present');
      assert.equal(segA.revenue, '200.0000');
      const segB = health.segments.department.find((row) => row.id === org.deptB);
      assert.ok(segB, 'segment whose only cost is expense_other is present');
      assert.equal(segB.revenue, '0.0000');
    });
  } finally { await withBypassContext(() => dropScratchOrg(org.scoped.orgId)); }
});
}}] as const; for (const row of pnlUniverseCases) await row.register();

const healthScopeCases = [{ label: "health-scope", register: async () => {
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const { registerHooks } = await import("node:module");
const { resolveAppModule } = await import("./test-module-hooks");
const { pathToFileURL } = await import("node:url");
const test = (await import("node:test")).default;
const React = await import("react");
type SessionUser = import("./auth").SessionUser;
type HealthData = import("./analytics/health-data").HealthData;
const { stubModules } = await import("../testing/stub-modules.ts");
const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null; period: { from: string; to: string; label: string } | null } = { user: null, period: null };
Object.assign(globalThis, { __healthScope: state, React });
stubModules({ intl: true, navigation: false, authz: false, features: false });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__healthScope.user}" };
  if (specifier.endsWith("/lib/periods") && /\/analytics\/financial-health\/(?:page\.tsx|view\.ts)$/.test(context.parentURL ?? "")) return { shortCircuit: true, url: "data:text/javascript,export async function resolvePeriod(){return globalThis.__healthScope.period}" };
  if (specifier === "../money-server" && context.parentURL?.includes("/analytics/")) return { shortCircuit: true, url: "data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}" };
  const app = resolveAppModule(specifier, context, next, root)
  if (app) return app
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { getAuthz } = await import("./authz");
const { healthData } = await import("./analytics/health-data");
// The page LOADER. This asks whether the page applies the reader's
// subsidiary scope, which the loader decides; the spec only names where the
// resolved data is drawn. Reading props off a rendered element stopped
// working when `ModuleView` became the single render path.
const { loadFinancialHealth } = await import("../app/(app)/analytics/financial-health/view");
const { executeAssistantTool } = await import("./assistant/registry");
const { accountingHome } = await import("./module-home/accounting");

for (const boundary of ["service", "completed month", "page", "assistant", "accounting budgets"] as const) {
  for (const mode of ["restricted", "empty", "all"] as const) {
    test(`Financial Health subsidiary access ${boundary}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await withBypassContext(() => createScratchOrg());
      try {
        const actor = await withBypassContext(() => createScratchUser(org.orgId, "Health reviewer", "health_reviewer"));
        const restriction = mode === "all" ? { mode: "all" } : { mode: "list", subsidiaryIds: mode === "empty" ? [] : [org.subsidiaryId] };
        await withBypassContext(async () => {
          await db.execute(sql`update app_roles set permissions='["reports.read","assistant.use"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='health_reviewer'`);
          await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"budgets":true}'::jsonb) where id=${org.orgId}`);
        });
        state.user = { id: actor, orgId: org.orgId, name: "Health reviewer", email: "health@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
        state.period = { from: "2026-07-01", to: boundary === "completed month" ? "2026-08-15" : org.date, label: "Health review" };
        const hidden = randomUUID();
        await withBypassContext(async () => {
          await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Private entity','CAD','CA')`);
          for (const [sub, amount, name] of [[org.subsidiaryId, '100', 'Visible'], [hidden, '999', 'PRIVATE-HEALTH-EVIDENCE']]) {
            const department = randomUUID(); const employee = randomUUID(); const entry = randomUUID();
            await db.execute(sql`insert into departments(id,org_id,name) values (${department},${org.orgId},${name})`);
            await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person',${name},${sub})`);
            await db.execute(sql`insert into employee_roles(org_id,party_id,hired_on) values (${org.orgId},${employee},'2026-01-01')`);
            await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
              values (${entry},${org.orgId},${org.bookId},${sub},${entry},${org.date},${org.periodId},'draft','manual')`);
            await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,amount,currency,txn_amount,fx_rate)
              values (${org.orgId},${entry},1,${org.accounts.bank},${sub},${department},${amount},'CAD',${amount},1),
                (${org.orgId},${entry},2,${org.accounts.revenue},${sub},${department},${'-'+amount},'CAD',${'-'+amount},1)`);
            await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
            const depreciation = randomUUID(); const expense = sub === org.subsidiaryId ? '10' : '99';
            await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
              values (${depreciation},${org.orgId},${org.bookId},${sub},${depreciation},${org.date},${org.periodId},'draft','depreciation')`);
            await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,amount,currency,txn_amount,fx_rate)
              values (${org.orgId},${depreciation},1,${org.accounts.adjustment},${sub},${department},${expense},'CAD',${expense},1),
                (${org.orgId},${depreciation},2,${org.accounts.bank},${sub},${department},${'-'+expense},'CAD',${'-'+expense},1)`);
            await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${depreciation}`);
          }
          for (const [index, label] of ['Visible budget','Group budget','PRIVATE-HEALTH-EVIDENCE'].entries()) {
            const scenario = randomUUID();
            await db.execute(sql`insert into budget_scenarios(id,org_id,book_id,fiscal_year,name) values (${scenario},${org.orgId},${org.bookId},2026,${label})`);
            const entries = index === 0 ? [[org.subsidiaryId,'-90']] : index === 1 ? [[org.subsidiaryId,'-120'],[hidden,'-990']] : [[hidden,'-500']];
            for (const [sub, amount] of entries) await db.execute(sql`insert into budget_lines(org_id,scenario_id,account_id,period_id,subsidiary_id,amount) values (${org.orgId},${scenario},${org.accounts.revenue},${org.periodId},${sub},${amount})`);
            await db.execute(sql`update budget_scenarios set status='pending_approval',revision=revision+1 where id=${scenario}`);
            await db.execute(sql`update budget_scenarios set status='approved',revision=revision+1,updated_at=${'2026-07-'+String(index+1).padStart(2,'0')}::date where id=${scenario}`);
          }
        });
        await withOrgContext(org.orgId, async () => {
          const authz = await getAuthz(); assert.ok(authz);
          if (boundary === "accounting budgets") {
            const data = await accountingHome(org.orgId, authz.allowedSubsidiaryIds, { gl: true, close: true, findings: true, accounts: true, budgets: true, assets: true });
            assert.equal(data.badges.budgets, mode === 'all' ? 3 : mode === 'empty' ? 0 : 1);
            return;
          }
          let data: Pick<HealthData, 'figures' | 'budget'>;
          if (boundary === "service" || boundary === "completed month") data = await healthData(state.period!, org.orgId, authz.allowedSubsidiaryIds);
          else if (boundary === "page") {
            data = ((await loadFinancialHealth({})) as { data: HealthData }).data;
          } else {
            const result = await executeAssistantTool(authz, 'analytics_financial_health', { fromDate: state.period!.from, toDate: state.period!.to });
            assert.equal(result.ok, true); assert.ok(result.ok);
            data = result.data as Pick<HealthData, 'figures' | 'budget'>;
          }
          assert.equal(data.figures.revenue, mode === 'all' ? "1099.0000" : mode === 'empty' ? "0.0000" : "100.0000");
          assert.equal(data.figures.depreciationAmortization, mode === 'all' ? "109.0000" : mode === 'empty' ? "0.0000" : "10.0000");
          assert.equal(data.figures.headcount, mode === 'all' ? 2 : mode === 'empty' ? 0 : 1);
          assert.equal(data.budget.totals.budget, mode === 'all' ? '500.0000' : mode === 'empty' ? '0.0000' : '120.0000');
          assert.equal(data.budget.totals.actual, mode === 'all' ? '1208.0000' : mode === 'empty' ? '0.0000' : '110.0000');
          assert.equal(JSON.stringify(data).includes('PRIVATE-HEALTH-EVIDENCE'), mode === 'all');
        });
      } finally { state.user = null; state.period = null; await dropScratchOrg(org.orgId); }
    });
  }
}
}}] as const; for (const row of healthScopeCases) await row.register();
