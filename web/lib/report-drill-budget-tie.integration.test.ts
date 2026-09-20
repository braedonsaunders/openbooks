import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The budget drill-down must tie to the budget vs actual report it supports:
// the same window and the same currency translation. It did neither — it
// always swept the scenario's whole fiscal year while the report shows the
// resolved (often year-to-date) window, and it summed raw functional amounts
// across currencies while the report translates every leg to the presentation
// currency. On a year-to-date, multi-currency book the drill's supporting
// totals agreed with nothing.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') {
    return { shortCircuit: true, url: `data:text/javascript,export async function getTranslations() { return (key) => key }` };
  }
  if (specifier === './money-server' || specifier.endsWith('/money-server')) {
    return { shortCircuit: true, url: `data:text/javascript,export async function getMoneyFormatter() { return { money: (value) => String(value) } }` };
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { loadReportDrillData } = await import('./report-drill-data.ts');
const { budgetVsActualView } = await import('./budget-report.ts');
type Authz = import('./authz.ts').Authz;

const DB = !!process.env.OPENBOOKS_DB_URL;
const JULY = { from: '2026-07-01', to: '2026-07-31' };

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: 'Controller', orgId,
      roles: [{ key: 'admin', name: 'admin' }],
      envKind: 'sandbox', productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(['reports.read']),
    allowedSubsidiaryIds: null,
  };
}

const labels = {
  actual: 'Actual', budget: 'Budget', variance: 'Variance', variancePct: 'Variance %',
  revenue: 'Revenue', costOfGoodsSold: 'COGS', grossProfit: 'Gross profit',
  expenses: 'Expenses', netIncome: 'Net income', totalOf: (s: string) => `Total ${s}`,
};

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;

async function postExpense(org: ScratchOrg, subsidiaryId: string, currency: string, amount: string, postedOn: string) {
  const entryId = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values (${entryId},${org.orgId},${org.bookId},${subsidiaryId},${entryId},${postedOn},${org.periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,party_id,is_open_item,amount,currency,txn_amount,fx_rate,posting_date)
    values (${randomUUID()},${org.orgId},${entryId},1,${org.accounts.cogs},${subsidiaryId},null,false,${amount},${currency},${amount},1,${postedOn}),
    (${randomUUID()},${org.orgId},${entryId},2,${org.accounts.bank},${subsidiaryId},null,false,-${amount}::numeric,${currency},-${amount}::numeric,1,${postedOn})`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entryId}`);
}

test('budget drill ties to the report window and currency', { skip: !DB }, async () => {
  // Fixture seeds under explicit bypass: importing the drill reader pulls in
  // the web request-org resolver, which denies every unscoped query under
  // pooled RLS (bare createScratchOrg dies with 42501). Reads below already
  // run under withOrgContext.
  const org = await withBypassContext(() => createScratchOrg());
  const usdSub = randomUUID();
  const augPeriod = randomUUID();
  const scenarioId = randomUUID();
  try {
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${usdSub}, ${org.orgId}, ${org.subsidiaryId}, 'US entity', 'USD', 'US')`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'USD', 'CAD', '2026-07-01', 'spot', 1.5, 'test')`);
      const calendar = (await db.execute<{ id: string }>(sql`
        select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id;
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${augPeriod}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar})`);
      await db.execute(sql`insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
        values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Tie probe', 'budget', 'draft')`);
      // July (in the report window) and August (outside it) lines per entity.
      await db.execute(sql`insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, 1000),
               (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${usdSub}, 2000),
               (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${augPeriod}, ${org.subsidiaryId}, 100),
               (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${augPeriod}, ${usdSub}, 5000)`);
      // Actuals mirror the budget shape: CAD legs at par, USD legs translated.
      await postExpense(org, org.subsidiaryId, 'CAD', '100', '2026-07-15');
      await postExpense(org, usdSub, 'USD', '200', '2026-07-15');
      await postExpense(org, org.subsidiaryId, 'CAD', '10', '2026-08-15');
      await postExpense(org, usdSub, 'USD', '500', '2026-08-15');
    });

    const authz = authzFor(org.orgId, randomUUID());
    const { reportActual, reportBudget, drillActual, drillBudget, drillListTotal } = await withOrgContext(org.orgId, async () => {
      const view = await budgetVsActualView(scenarioId, org.orgId, labels, {}, undefined, JULY);
      const row = view!.lines.find((l) => l.kind === 'account'
        && (l as { accountId?: unknown }).accountId === org.accounts.cogs) as { values: unknown[] } | undefined;
      assert.ok(row, 'report must render the COGS account row');
      const variance = await loadReportDrillData(
        { kind: 'budget', label: 'COGS', scenarioId, scope: 'variance', accountIds: [org.accounts.cogs], from: JULY.from, to: JULY.to },
        authz, 1,
      );
      const list = await loadReportDrillData(
        { kind: 'budget', label: 'COGS', scenarioId, scope: 'budget', accountIds: [org.accounts.cogs], from: JULY.from, to: JULY.to },
        authz, 1,
      );
      return {
        reportActual: Number(row.values[0]), reportBudget: Number(row.values[1]),
        drillActual: Number(variance.summary[0]!.value), drillBudget: Number(variance.summary[1]!.value),
        drillListTotal: Number(list.summary[0]!.value),
      };
    });
    // Fixture economics at USD->CAD 1.5: actual 100 + 200*1.5 = 400;
    // budget 1000 + 2000*1.5 = 4000. August lines must not leak in.
    assert.equal(reportActual, 400);
    assert.equal(reportBudget, 4000);
    assert.equal(drillActual, reportActual, 'drill actual must tie to the report actual');
    assert.equal(drillBudget, reportBudget, 'drill budget must tie to the report budget');
    assert.equal(drillListTotal, reportBudget, 'drill budget list must tie to the report budget');
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
