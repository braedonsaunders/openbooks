import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'

stubModules({ intl: true, navigation: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './money-server' || specifier.endsWith('/money-server')) {
      return { shortCircuit: true, url: `data:text/javascript,export async function getMoneyFormatter() { return { money: (value) => String(value) } }` };
    }
    return next(specifier, context);
  },
});

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadReportDrillData } = await import('./report-drill-data')
const { transactionDetail } = await import('./reports/transaction-detail')
const { encodeReportDrillTarget, parseReportDrillTarget } = await import('./report-drill')
import type { ReportDrillTarget } from './report-drill'

/**
 * A drill drawer must show the supporting lines of the exact cell the user
 * clicked. Statement cells aggregate the view's full entity set (a subtree
 * for consolidated views); the drill shares that set. Narrowing the drill
 * to the picker node alone drops every child entity's lines behind a
 * consolidated total.
 */
async function seedRevenue(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  input: { number: string; subsidiaryId: string; total: string },
): Promise<string> {
  const entryId = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, created_by, updated_by
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${input.subsidiaryId}, ${input.number},
      ${org.date}, ${org.periodId}, 'draft', 'manual', ${actorId}, ${actorId}
    )
  `))
  await withBypassContext(() => db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id,
      is_open_item, amount, currency, txn_amount, fx_rate
    ) values
      (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.revenue}, ${input.subsidiaryId},
       false, ${`-${input.total}`}, 'CAD', ${`-${input.total}`}, '1'),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${input.subsidiaryId},
       false, ${input.total}, 'CAD', ${input.total}, '1')
  `))
  await withBypassContext(() => db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`))
  return entryId
}

test('a consolidated drill ties to its cell across the whole subtree', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Reporter', 'admin'))
  try {
    const branchId = randomUUID()
    let rootEntry = ''
    let branchEntry = ''
    await withBypassContext(() => db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Drill branch', 'CAD', 'CA')
      `))
    rootEntry = await seedRevenue(scratch, actorId, { number: 'DRILL-ROOT', subsidiaryId: scratch.subsidiaryId, total: '100' })
    branchEntry = await seedRevenue(scratch, actorId, { number: 'DRILL-BRANCH', subsidiaryId: branchId, total: '200' })
    const root = scratch.subsidiaryId
    const subtree = [root, branchId]
    const authz = {
      user: {
        id: actorId, email: 'reporter@example.com', name: 'Reporter', roles: [],
        orgId: scratch.orgId, envKind: 'production', productionOrgId: scratch.orgId,
        homeUserId: actorId, homeOrgId: scratch.orgId, isSuperAdmin: true,
      },
      permissions: new Set<string>(['*']),
      allowedSubsidiaryIds: null,
    } as const

    // The cell the trial balance shows for an explicitly root-scoped
    // (consolidated) view: both entities' revenue.
    const cell = await withBypass(() => transactionDetail({
      accountTypes: ['income'],
      from: scratch.date,
      to: scratch.date,
      mode: 'flow',
      dims: { subsidiaryIds: subtree },
      orgId: scratch.orgId,
      bookId: scratch.bookId,
    }))
    assert.equal(cell.count, 2, 'the cell aggregates the whole subtree')
    assert.equal(Number(cell.net), 300, 'cell net covers both entities')

    // The drill target the trial-balance view builds for that same cell:
    // the view's dims (the subtree) plus the picker node.
    const target: ReportDrillTarget = {
      kind: 'ledger',
      label: 'Revenue',
      accountTypes: ['income'],
      from: scratch.date,
      to: scratch.date,
      mode: 'flow',
      dims: { subsidiaryIds: subtree },
      subsidiaryId: root,
      bookId: scratch.bookId,
    }
    // Drills travel to the API as URL state: round-trip through the real
    // codec so the tie-out holds across serialization, not just in memory.
    const parsed = parseReportDrillTarget(encodeReportDrillTarget(target))
    assert.ok(parsed, 'the drill target survives its URL codec')
    const drill = await withBypass(() => loadReportDrillData(parsed, { ...authz, allowedSubsidiaryIds: null }, 1))
    assert.equal(drill.total, 2, 'the drill supports the whole cell, not just the picker node')
    const drilled = new Set(drill.rows.map((row) => row.transaction?.entryId))
    assert.ok(drilled.has(rootEntry) && drilled.has(branchEntry), 'both entities land in the drawer')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('a drill never widens a restricted caller past its allowlist', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Reporter', 'admin'))
  try {
    const branchId = randomUUID()
    let branchEntry = ''
    await withBypassContext(() => db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Drill branch', 'CAD', 'CA')
      `))
    await seedRevenue(scratch, actorId, { number: 'DRILL-ROOT', subsidiaryId: scratch.subsidiaryId, total: '100' })
    branchEntry = await seedRevenue(scratch, actorId, { number: 'DRILL-BRANCH', subsidiaryId: branchId, total: '200' })
    const root = scratch.subsidiaryId
    // A restricted caller who may see only the root, handed a target whose
    // embedded entity set (and picker node) point at the hidden branch.
    const forged: ReportDrillTarget = {
      kind: 'ledger',
      label: 'Revenue',
      accountTypes: ['income'],
      from: scratch.date,
      to: scratch.date,
      mode: 'flow',
      dims: { subsidiaryIds: [root, branchId] },
      subsidiaryId: branchId,
      bookId: scratch.bookId,
    }
    const parsed = parseReportDrillTarget(encodeReportDrillTarget(forged))
    assert.ok(parsed, 'the forged target survives its URL codec')
    const restricted = {
      user: {
        id: actorId, email: 'reporter@example.com', name: 'Reporter', roles: [],
        orgId: scratch.orgId, envKind: 'production', productionOrgId: scratch.orgId,
        homeUserId: actorId, homeOrgId: scratch.orgId, isSuperAdmin: false,
      },
      permissions: new Set<string>(['reports.read']),
      allowedSubsidiaryIds: new Set([root]),
    } as const
    const drill = await withBypass(() => loadReportDrillData(parsed, { ...restricted, allowedSubsidiaryIds: new Set([root]) }, 1))
    assert.equal(drill.total, 1, 'the drill stays inside the caller allowlist')
    assert.ok(
      !drill.rows.some((row) => row.transaction?.entryId === branchEntry),
      'the hidden branch never lands in the drawer',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})


const consolidatedRows = [
  { label: "report drill budget scope", register: async () => {
        const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const { stubModules } = await import("../testing/stub-modules.ts");
        // The budget drill-down must scope budget lines by the line's own legal
        // entity — the rule every sibling reader applies (budget vs actual report,
        // scenario list totals, module-home scenario gate: all key on
        // bl.subsidiary_id). The drill instead attributed lines through dimension
        // owners and never read bl.subsidiary_id at all, which cut both ways for a
        // subsidiary-restricted caller: another entity's line wearing one of your
        // dimensions leaked in, while your own undimensioned lines were denied —
        // even though the report and the list right beside the drill showed them.
        stubModules({ intl: true, navigation: false, authz: false, features: false });

        registerHooks({ resolve(specifier, context, next) {
          if (specifier === './money-server' || specifier.endsWith('/money-server')) {
            return { shortCircuit: true, url: `data:text/javascript,export async function getMoneyFormatter() { return { money: (value) => String(value) } }` };
          }
          return next(specifier, context);
        } });
        const { sql } = await import('drizzle-orm');
        const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
        const { loadReportDrillData } = await import('./report-drill-data.ts');
        type Authz = import('./authz.ts').Authz;

        const DB = !!process.env.OPENBOOKS_DB_URL;

        function authzFor(orgId: string, userId: string, allowed: string[]): Authz {
          return {
            user: {
              id: userId, email: `${userId}@test`, name: 'Restricted Reader', orgId,
              roles: [{ key: 'viewer', name: 'viewer' }],
              envKind: 'sandbox', productionOrgId: orgId, isSuperAdmin: false,
              homeUserId: userId, homeOrgId: orgId,
            },
            permissions: new Set(['reports.read']),
            allowedSubsidiaryIds: new Set(allowed),
          };
        }

        test('budget drill keys lines on the line subsidiary, not dimension owners', { skip: !DB }, async () => {
          // Fixture seeds under explicit bypass: importing ./report-drill-data.ts
          // above pulls in the web request-org resolver, which denies every unscoped
          // query under pooled RLS (bare setup dies with 42501). The drill issues
          // bare reads with explicit org predicates, so it runs in the scratch org's
          // scope; the authz provides the app-level subsidiary restriction under test.
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const otherSub = randomUUID();
            const deptId = randomUUID();
            const scenarioId = randomUUID();
            await withBypassContext(async () => {
              await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
                values (${otherSub}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA')`);
              await db.execute(sql`insert into departments (id, org_id, name, subsidiary_id)
                values (${deptId}, ${org.orgId}, 'Home department', ${org.subsidiaryId})`);
              await db.execute(sql`insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
                values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Scope probe', 'budget', 'draft')`);
              // Own line, no dimensions: the report and the list both show it.
              await db.execute(sql`insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
                values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, 100)`);
              // Another entity's line wearing one of our dimensions: must stay hidden.
              await db.execute(sql`insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, amount)
                values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${otherSub}, ${deptId}, 999)`);
            });

            const authz = authzFor(org.orgId, randomUUID(), [org.subsidiaryId]);
            const drill = await withOrgContext(org.orgId, () => loadReportDrillData(
              { kind: 'budget', label: 'COGS budget', scenarioId, scope: 'budget' },
              authz,
              1,
            ));
            const amounts = drill.rows.map((row) => row.cells[3]);
            assert.ok(!amounts.includes('999.0000'), 'another entity line must not leak through a shared dimension');
            assert.ok(amounts.includes('100.0000'), 'own undimensioned line must be visible in the drill');
            assert.equal(drill.total, 1);
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "report drill budget tie", register: async () => {
        const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const { stubModules } = await import("../testing/stub-modules.ts");
        // The budget drill-down must tie to the budget vs actual report it supports:
        // the same window and the same currency translation. It did neither — it
        // always swept the scenario's whole fiscal year while the report shows the
        // resolved (often year-to-date) window, and it summed raw functional amounts
        // across currencies while the report translates every leg to the presentation
        // currency. On a year-to-date, multi-currency book the drill's supporting
        // totals agreed with nothing.
        stubModules({ intl: true, navigation: false, authz: false, features: false });

        registerHooks({ resolve(specifier, context, next) {
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
  } },
  { label: "report drill order scopes", register: async () => {
        const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypass, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { stubModules } = await import("../testing/stub-modules.ts");
        // Database partition: order drill scopes route through live SQL predicates
        // (open/backlog, converted/linked, voided) that only PostgreSQL can answer.
        // The unit suite keeps the URL round-trip and clamping cover in
        // report-drill.test.ts; the scope routing is proved here against seeded
        // orders. next-intl has no request scope in plain node, so translations
        // resolve to the key (labels are never asserted).

        stubModules({ intl: true, navigation: {}, authz: false, features: false });

        const hooks = registerHooks({
          resolve(specifier, context, nextResolve) {
            return nextResolve(specifier, context)
          },
        })

        const { loadReportDrillData } = await import('./report-drill-data.ts')
        hooks.deregister()

        type Scope = 'open' | 'converted' | 'conversion' | 'voided'

        async function seedOrder(
          orgId: string,
          subsidiaryId: string,
          customerId: string,
          revenueAccountId: string,
          actorId: string,
          date: string,
          number: string,
          status: string,
          quantity: string,
          quantityBilled: string,
        ): Promise<string> {
          const id = randomUUID()
          await db.execute(sql`
            insert into documents
              (id, org_id, kind, document_number, party_id, subsidiary_id,
               document_date, currency, fx_rate, status, subtotal, tax_total, total,
               created_by, updated_by)
            values (${id}, ${orgId}, 'sales_order', ${number}, ${customerId},
                    ${subsidiaryId}, ${date}, 'USD', '1', 'draft',
                    '100.0000', '0', '100.0000', ${actorId}, ${actorId})`)
          await db.execute(sql`
            insert into document_lines
              (org_id, document_id, line_number, account_id, quantity,
               quantity_billed, unit_price, amount, tax_input_amount, tax_amount,
               created_by, updated_by)
            values (${orgId}, ${id}, 1, ${revenueAccountId}, ${quantity},
                    ${quantityBilled}, '100.0000', '100.0000', '100.0000', '0', ${actorId}, ${actorId})`)
          // Lines are immutable outside draft status (document_line_immutability
          // guard), so seed the lines first and promote the document after.
          // Voiding additionally requires the documented void reason.
          if (status !== 'draft') {
            await db.execute(sql`update documents
               set status = ${status},
                   voided_at = case when ${status} = 'voided' then now() end,
                   voided_by = case when ${status} = 'voided' then ${actorId}::uuid end,
                   void_reason = case when ${status} = 'voided' then 'drill scope fixture' end
             where id = ${id} and org_id = ${orgId}`)
          }
          return id
        }

        async function scopedNumbers(
          orgId: string,
          userId: string,
          scope: Scope,
        ): Promise<string[]> {
          const response = await loadReportDrillData(
            { kind: 'orders', label: 'Orders', orderKind: 'sales_order', scope },
            {
              // orderData reads only the org id and the scope; the remaining
              // principal fields ride along for the Authz type.
              user: {
                id: userId,
                email: 'drill-scope-clerk@example.test',
                name: 'Drill scope clerk',
                roles: [],
                orgId,
                envKind: 'sandbox',
                productionOrgId: orgId,
                isSuperAdmin: false,
                homeUserId: userId,
                homeOrgId: orgId,
              },
              permissions: new Set(),
              allowedSubsidiaryIds: null,
            },
            1,
          )
          assert.equal(response.total, response.rows.length)
          return response.rows.map((row) => String(row.cells[1])).sort()
        }

        test('order drill routes open, converted, and voided scopes through the right predicates', async () => {
          const org = await withBypass(() => createScratchOrg())
          try {
            const actorId = await withBypass(() => createScratchUser(org.orgId, 'Drill scope clerk', 'drill_scope_clerk'))
            await withBypassContext(async () => {
              const seed = (number: string, status: string, quantity: string, quantityBilled: string) =>
                seedOrder(org.orgId, org.subsidiaryId, org.customerId, org.accounts.revenue, actorId, org.date, number, status, quantity, quantityBilled)
              await seed('SO-OPEN-1', 'approved', '5', '2')
              const convertedId = await seed('SO-CONV-1', 'approved', '5', '5')
              const linkTarget = await seed('SO-CONV-TARGET', 'approved', '1', '1')
              await db.execute(sql`
                insert into document_links
                  (org_id, from_document_id, to_document_id, link_type, created_by)
                values (${org.orgId}, ${convertedId}, ${linkTarget}, 'fulfills', ${actorId})`)
              await seed('SO-VOID-1', 'voided', '5', '0')
            })

            // Reads run under the org scope, proving the routing holds under
            // enforcement rather than under the seed bypass. The open scope needs
            // unconverted line quantity; the converted scope needs a document
            // link; the voided scope needs the voided status — each scope sees
            // exactly its own population.
            await withOrgContext(org.orgId, async () => {
              assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'open'), ['SO-OPEN-1'])
              assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'converted'), ['SO-CONV-1'])
              assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'conversion'), ['SO-CONV-1'])
              assert.deepEqual(await scopedNumbers(org.orgId, actorId, 'voided'), ['SO-VOID-1'])
            })
          } finally {
            await withBypass(() => dropScratchOrg(org.orgId))
          }
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
