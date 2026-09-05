import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as React from "react";
import type { SessionUser } from "./auth";
import type { HealthData } from "./analytics/health-data";

const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null; period: { from: string; to: string; label: string } | null } = { user: null, period: null };
Object.assign(globalThis, { __healthScope: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__healthScope.user}" };
  if (specifier.endsWith("/lib/periods") && context.parentURL?.endsWith("/analytics/financial-health/page.tsx")) return { shortCircuit: true, url: "data:text/javascript,export async function resolvePeriod(){return globalThis.__healthScope.period}" };
  if (specifier === "../money-server" && context.parentURL?.includes("/analytics/")) return { shortCircuit: true, url: "data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}" };
  if (specifier.startsWith("@/")) {
    const path = root + "web/" + specifier.slice(2);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { getAuthz } = await import("./authz");
const { healthData } = await import("./analytics/health-data");
const { default: HealthPage } = await import("../app/(app)/analytics/financial-health/page");
const { executeAssistantTool } = await import("./assistant/registry");
const { accountingHome } = await import("./module-home/accounting");

for (const boundary of ["service", "completed month", "page", "assistant", "accounting budgets"] as const) {
  for (const mode of ["restricted", "empty", "all"] as const) {
    test(`Financial Health subsidiary access ${boundary}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actor = await createScratchUser(org.orgId, "Health reviewer", "health_reviewer");
        const restriction = mode === "all" ? { mode: "all" } : { mode: "list", subsidiaryIds: mode === "empty" ? [] : [org.subsidiaryId] };
        await db.execute(sql`update app_roles set permissions='["reports.read","assistant.use"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='health_reviewer'`);
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"budgets":true}'::jsonb) where id=${org.orgId}`);
        state.user = { id: actor, orgId: org.orgId, name: "Health reviewer", email: "health@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
        state.period = { from: "2026-07-01", to: boundary === "completed month" ? "2026-08-15" : org.date, label: "Health review" };
        const hidden = randomUUID();
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
        await withOrgContext(org.orgId, async () => {
          const authz = await getAuthz(); assert.ok(authz);
          if (boundary === "accounting budgets") {
            const data = await accountingHome(org.orgId, authz.allowedSubsidiaryIds);
            assert.equal(data.badges.budgets, mode === 'all' ? 3 : mode === 'empty' ? 0 : 1);
            return;
          }
          let data: Pick<HealthData, 'figures' | 'budget'>;
          if (boundary === "service" || boundary === "completed month") data = await healthData(state.period!, org.orgId, authz.allowedSubsidiaryIds);
          else if (boundary === "page") {
            const output = await HealthPage({ searchParams: Promise.resolve({}) });
            const children = React.Children.toArray((output.props as { children: React.ReactNode }).children);
            const view = children.find(React.isValidElement); assert.ok(view && React.isValidElement(view));
            data = (view.props as { data: HealthData }).data;
          } else {
            const result = await executeAssistantTool(authz, 'analytics_financial_health', { fromDate: state.period!.from, toDate: state.period!.to });
            assert.equal(result.ok, true); assert.ok(result.ok);
            data = result.data as Pick<HealthData, 'figures' | 'budget'>;
          }
          assert.equal(data.figures.revenue, mode === 'all' ? 1099 : mode === 'empty' ? 0 : 100);
          assert.equal(data.figures.depreciationAmortization, mode === 'all' ? 109 : mode === 'empty' ? 0 : 10);
          assert.equal(data.figures.headcount, mode === 'all' ? 2 : mode === 'empty' ? 0 : 1);
          assert.equal(data.budget.totals.budget, mode === 'all' ? 500 : mode === 'empty' ? 0 : 120);
          assert.equal(data.budget.totals.actual, mode === 'all' ? 1208 : mode === 'empty' ? 0 : 110);
          assert.equal(JSON.stringify(data).includes('PRIVATE-HEALTH-EVIDENCE'), mode === 'all');
        });
      } finally { state.user = null; state.period = null; await dropScratchOrg(org.orgId); }
    });
  }
}
