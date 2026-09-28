import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { saveOpeningBalances } from "@openbooks/engine/src/payroll/opening-balances.ts";
import { commitPayRun } from "@openbooks/engine/src/payroll/run-commit.ts";
import { dropScratchOrgReporting } from "@openbooks/engine/src/testing/fixtures.ts";
import {
  calculatedRun,
  seedAdoption,
} from "@openbooks/engine/src/payroll/filing-test-fixtures.ts";
import type { Authz } from "./authz";

/**
 * Every payroll population has ONE scope decision, and the server pages, the
 * JSON routes and the assistant tools all read it through the loaders under
 * test here. Before this module existed the pages and the tools called the
 * engine directly and rendered a restricted caller wage data its own API
 * refused with 404.
 */

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The assistant tool file checks the payroll feature switch; the scratch
    // org has payroll off by default and the switch is not what is under test.
    if (
      specifier === "../features" &&
      context.parentURL?.endsWith("/assistant/tools-payroll.ts")
    ) {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function isFeatureEnabled(){return true}",
      };
    }
    return nextResolve(specifier, context);
  },
});
const views = await import("./payroll-scoped-views.ts");
const { PAYROLL_TOOLS } = await import("./assistant/tools-payroll.ts");
hooks.deregister();

const tool = (name: string) => {
  const found = PAYROLL_TOOLS.find((t) => t.name === name);
  assert.ok(found, name);
  return found;
};

test(
  "payroll pages and assistant tools carry the caller's subsidiary scope like the API routes",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // Fixture seeds under explicit bypass: importing the scoped views and
    // assistant tools above pulls in the web request-org resolver, which
    // denies every unscoped query under pooled RLS (bare setup dies with
    // 42501). The views and tools issue bare reads with explicit org
    // predicates, so they run in the scratch org's scope below; the gates
    // provide the app-level subsidiary filtering under test.
    const fx = await withBypassContext(() => seedAdoption());
    try {
      const hidden = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,name,base_currency,country,parent_id,is_elimination,is_active,custom)
          values(${hidden},${fx.orgId},'Other employer','CAD','CA',${fx.subsidiaryId},false,true,'{}'::jsonb)`);
        await db.execute(
          sql`update parties set subsidiary_id=${fx.subsidiaryId} where id=${fx.employeeId} and org_id=${fx.orgId}`,
        );
      });
      const { input } = await withBypassContext(() => calculatedRun(fx));
      await withBypassContext(() => commitPayRun(input));
      // A prior-year carry-in: the committed 2026 run locks 2026, not 2025.
      const saved = await withBypassContext(() => saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2025,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "5000.00", cppYtd: "100.00" }, components: {} }],
      }));
      assert.deepEqual(saved.errors, []);

      const gate = (allowed: Set<string> | null): Authz => ({
        user: { orgId: fx.orgId, id: fx.actorId } as Authz["user"],
        permissions: new Set(["payroll.read", "payroll.manage"]),
        allowedSubsidiaryIds: allowed,
      });
      const unrestricted = gate(null);
      const visible = gate(new Set([fx.subsidiaryId]));
      const restricted = gate(new Set([hidden]));

      // All views and tool calls below run in the scratch org's scope.
      await withOrgContext(fx.orgId, async () => {
        // Year-end: the whole population is refused, never partially rendered.
        const everyone = await views.scopedYearEndFilings(unrestricted, 2026);
        assert.ok(everyone);
        const t4 = everyone.find((f) => f.country === "CA" && f.key === "t4");
        assert.ok(t4 && t4.data.rows.length === 1, "the committed run produced one slip");
        assert.deepEqual(await views.scopedYearEndFilings(visible, 2026), everyone);
        assert.equal(await views.scopedYearEndFilings(restricted, 2026), null);

        // Remittances: employer-level aggregate, refused outright when hidden.
        const groups = await views.scopedRemittanceSummary(unrestricted, {
          from: "2026-07-01",
          to: "2026-07-31",
        });
        assert.ok(groups && groups.length > 0);
        assert.deepEqual(
          await views.scopedRemittanceSummary(visible, { from: "2026-07-01", to: "2026-07-31" }),
          groups,
        );
        assert.equal(
          await views.scopedRemittanceSummary(restricted, { from: "2026-07-01", to: "2026-07-31" }),
          null,
        );

        // Opening balances and bank carry-ins: filtered to visible employees.
        const openings = await views.scopedOpeningBalances(unrestricted, 2025);
        assert.ok(openings.rows.some((r) => r.employeePartyId === fx.employeeId && r.amounts !== null));
        assert.deepEqual(openings.years, [2025]);
        const visibleOpenings = await views.scopedOpeningBalances(visible, 2025);
        assert.ok(visibleOpenings.rows.some((r) => r.employeePartyId === fx.employeeId));
        assert.deepEqual(visibleOpenings.years, [2025]);
        const hiddenOpenings = await views.scopedOpeningBalances(restricted, 2025);
        assert.equal(hiddenOpenings.rows.length, 0);
        assert.equal(hiddenOpenings.entered, 0);
        assert.deepEqual(hiddenOpenings.years, []);

        const banks = await views.scopedEntitlementOpenings(unrestricted);
        assert.ok(banks.rows.some((r) => r.employeePartyId === fx.employeeId));
        const hiddenBanks = await views.scopedEntitlementOpenings(restricted);
        assert.equal(hiddenBanks.rows.length, 0);
        assert.deepEqual(Object.keys(hiddenBanks.blocked), []);

        // Retro: an org-wide schedule follows the root convention.
        assert.deepEqual(
          (await views.scopedRetroSchedules(visible)).map((s) => s.id),
          [fx.scheduleId],
        );
        assert.deepEqual(await views.scopedRetroSchedules(restricted), []);

        // Assistant tools: the same decisions, expressed as tool results.
        const runs = tool("list_pay_runs");
        const allRuns = await runs.execute({}, unrestricted);
        assert.ok(allRuns.ok && (allRuns.data as { returned: number }).returned === 1);
        const hiddenRuns = await runs.execute({}, restricted);
        assert.ok(hiddenRuns.ok && (hiddenRuns.data as { returned: number }).returned === 0);

        const run = tool("get_pay_run");
        assert.equal((await run.execute({ documentId: input.documentId }, visible)).ok, true);
        assert.deepEqual(await run.execute({ documentId: input.documentId }, restricted), {
          ok: false,
          error: "pay_run_not_found",
        });

        const yearEnd = tool("payroll_year_end");
        assert.equal((await yearEnd.execute({ taxYear: 2026 }, visible)).ok, true);
        assert.deepEqual(await yearEnd.execute({ taxYear: 2026 }, restricted), {
          ok: false,
          error: "not_found",
        });

        const employees = tool("list_payroll_employees");
        const allEmployees = await employees.execute({}, unrestricted);
        assert.ok(allEmployees.ok && (allEmployees.data as { returned: number }).returned === 1);
        const hiddenEmployees = await employees.execute({}, restricted);
        assert.ok(hiddenEmployees.ok && (hiddenEmployees.data as { returned: number }).returned === 0);

        const entitlements = tool("payroll_entitlements");
        assert.equal(
          (await entitlements.execute({ employeePartyId: fx.employeeId }, visible)).ok,
          true,
        );
        assert.deepEqual(await entitlements.execute({ employeePartyId: fx.employeeId }, restricted), {
          ok: false,
          error: "employee_not_found",
        });

        const remittances = tool("payroll_remittances");
        assert.equal(
          (await remittances.execute({ fromDate: "2026-07-01", toDate: "2026-07-31" }, visible)).ok,
          true,
        );
        assert.deepEqual(
          await remittances.execute({ fromDate: "2026-07-01", toDate: "2026-07-31" }, restricted),
          { ok: false, error: "not_found" },
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);


const payrollReportingCases = [
  { label: "payroll collapse", register: async () => {
        const { pathToFileURL } = await import('node:url');
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const test = (await import('node:test')).default;
        const { randomUUID } = await import('node:crypto');
        const { cmp, sum } = await import('@openbooks/engine/src/money/money.ts');
        /**
         * PAYCONF-c/d/e (collapse semantics): payroll legs arrive pre-collapsed per
         * (entry, account) in the entity FROM — before any caller filter, breakout,
         * grouping, sort, or LIMIT, in every mode — so no rows-mode projection (with
         * or without identity keys), limit:1 plan, amount section split, amount
         * equality oracle, sort, or summarize amount-breakout can return a
         * pre-collapse per-employee row or isolate an individual amount. Totals tie
         * out by construction; the grant restores full detail.
         *
         * Two employees share one pay-run journal/account with distinct net pays.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, pool, withBypassContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        // runCustomQuery directly: the web executeReport wrapper needs a Next request
        // scope (cookies) for locale/feature prep, which tests lack.
        const { runCustomQuery } = (await import(root + 'packages/reports/src/run.ts')) as typeof import('@openbooks/reports')
        const { REPORT_ENTITY_MAP } = (await import(root + 'packages/reports/src/entities.ts')) as typeof import('@openbooks/reports')
        const { PAYROLL_RESTRICTED_PARTY_LABEL, payrollRestrictedEntity } = (await import(root + 'packages/reports/src/confidential-entities.ts')) as typeof import('@openbooks/reports')

        type Org = Awaited<ReturnType<typeof createScratchOrg>>

        const NET_A = '4842.17'
        const NET_B = '5210.44'
        const NAME_A = 'Avery Employee'
        const NAME_B = 'Blake Employee'

        async function seedPayroll(org: Org) {
          return withBypassContext(async () => {
          const empA = randomUUID()
          const empB = randomUUID()
          const employees = await db.execute<{ id: string }>(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
            values (${empA}, ${org.orgId}, 'employee', ${NAME_A}, ${org.subsidiaryId}),
                   (${empB}, ${org.orgId}, 'employee', ${NAME_B}, ${org.subsidiaryId}) returning id`)
          assert.deepEqual(employees.rows.map(row => row.id).sort(), [empA, empB].sort(), 'payroll reporting employees are stored')
          const payDoc = randomUUID()
          // Status stays non-posted: a posted document must reference its posted
          // entry, and the collapse keys on kind, not status.
          await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, subsidiary_id, currency, subtotal, tax_total, total, fx_rate, status)
            values (${payDoc}, ${org.orgId}, 'pay_run', 'PAY-1', ${org.date}, ${org.date}, ${org.subsidiaryId}, 'USD', 0, 0, 10052.61, 1, 'approved')`)
          // One balanced pay-run entry: both employees' net-pay legs on the SAME
          // payable account, offset to wages expense.
          const entryId = randomUUID()
          // Draft first: the posted-balance trigger requires at least two balanced
          // lines to exist before an entry may post.
          await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
            values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'JE-PAY-1', ${org.date}, ${org.periodId}, 'Pay run PAY-1', 'draft', 'document', ${payDoc})`)
          // Net-pay legs are credits (negative), offset by the wage-expense debit —
          // the posting sign convention. The entry balances: -4842.17 + -5210.44 +
          // 10052.61 = 0.
          await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
            values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${empA}, true, -4842.17, 'USD', -4842.17, 1, ${org.date}),
                   (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, ${empB}, true, -5210.44, 'USD', -5210.44, 1, ${org.date}),
                   (${randomUUID()}, ${org.orgId}, ${entryId}, 3, ${org.accounts.cogs}, ${org.subsidiaryId}, null, false, 10052.61, 'USD', 10052.61, 1, ${org.date})`)
          // One ordinary (non-payroll) line on the same account proves the collapse
          // merges payroll legs only, not the account.
          const plainId = randomUUID()
          await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
            values (${plainId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'JE-PLAIN-1', ${org.date}, ${org.periodId}, 'plain', 'draft', 'manual')`)
          await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
            values (${randomUUID()}, ${org.orgId}, ${plainId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, null, false, 100, 'USD', 100, 1, ${org.date}),
                   (${randomUUID()}, ${org.orgId}, ${plainId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, null, false, -100, 'USD', -100, 1, ${org.date})`)
          const posted = await db.execute<{ id: string }>(sql`update journal_entries set status = 'posted' where id in (${entryId}, ${plainId}) and org_id = ${org.orgId} returning id`)
          assert.deepEqual(posted.rows.map(row => row.id).sort(), [entryId, plainId].sort(), 'payroll and ordinary comparison journals are posted once each')
          })
        }

        const LEDGER = 'ledger_lines'

        function baseOpts(org: Org, canSeePayroll: boolean) {
          return {
            entityMap: {
              ...REPORT_ENTITY_MAP,
              [LEDGER]: payrollRestrictedEntity(REPORT_ENTITY_MAP[LEDGER]!, canSeePayroll),
            },
            orgId: org.orgId,
          }
        }

        function leakedIdentity(payload: unknown): string | null {
          const text = JSON.stringify(payload)
          for (const secret of [NAME_A, NAME_B]) {
            if (text.includes(secret)) return secret
          }
          return null
        }

        function leakedAmount(payload: unknown): string | null {
          const text = JSON.stringify(payload)
          for (const secret of [NET_A, NET_B]) {
            if (text.includes(secret)) return secret
          }
          return null
        }

        test('rows mode without key columns collapses to the entry total', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            const result = await runCustomQuery(pool, {
              entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
            }, baseOpts(org, false))
            assert.equal(leakedIdentity(result.groups), null, 'payroll identity leaked through a keyless projection')
            assert.equal(leakedAmount(result.groups), null, 'a pre-collapse per-employee amount leaked')
            const text = JSON.stringify(result.groups)
            assert.ok(text.includes(PAYROLL_RESTRICTED_PARTY_LABEL), 'the collapsed row must carry the restricted label')
            // The ordinary line on the same account stays visible.
            assert.ok(text.includes('100'), 'non-payroll rows must survive the collapse')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('limit:1 with an ascending amount sort returns the collapsed row', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            const result = await runCustomQuery(pool, {
              entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
              sorts: [{ column: 'amount', direction: 'asc' }], limit: 1,
            }, baseOpts(org, false))
            assert.equal(leakedIdentity(result.groups), null, 'limit:1 isolated an individual pay')
            assert.equal(leakedAmount(result.groups), null, 'limit:1 isolated an individual amount')
            assert.ok(JSON.stringify(result.groups).includes(PAYROLL_RESTRICTED_PARTY_LABEL))
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test("groupBy:'amount' with all identity keys yields entry totals only", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            const result = await runCustomQuery(pool, {
              entity: LEDGER, mode: 'rows',
              columns: ['posting_date', 'party_name', 'amount', 'entry_id', 'account_id', 'party_id'],
              groupBy: 'amount',
            }, baseOpts(org, false))
            assert.equal(leakedIdentity(result.groups), null, 'an amount section carried an individual identity')
            assert.equal(leakedAmount(result.groups), null, 'an amount section carried an individual amount')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('an amount equality oracle matches only the entry total', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            // A leg amount matches no collapsed row.
            const missed = await runCustomQuery(pool, {
              entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
              filters: { combinator: 'and', rules: [{ field: 'amount', op: 'eq', value: `-${NET_A}` }] },
            }, baseOpts(org, false))
            assert.equal(missed.rowCount, 0, 'the amount oracle matched a payroll leg')
            // The entry total does match — as one collapsed row, naming no employee.
            const hit = await runCustomQuery(pool, {
              entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'],
              filters: { combinator: 'and', rules: [{ field: 'amount', op: 'eq', value: '-10052.61' }] },
            }, baseOpts(org, false))
            assert.equal(hit.rowCount, 1, 'the entry total must match its collapsed row')
            assert.equal(leakedIdentity(hit.groups), null)
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('summarize with an amount breakout forms entry-total buckets only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            const result = await runCustomQuery(pool, {
              entity: LEDGER, mode: 'summarize', columns: [],
              breakouts: [{ column: 'amount' }], measures: [{ fn: 'count' }],
            }, baseOpts(org, false))
            assert.equal(leakedIdentity(result.groups), null, 'an amount bucket exposed an individual identity')
            assert.equal(leakedAmount(result.groups), null, 'an amount bucket exposed an individual amount')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('restricted and granted money tie out; the grant restores detail (control)', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            const q = { entity: LEDGER, mode: 'rows', columns: ['posting_date', 'party_name', 'amount'] }
            const restricted = await runCustomQuery(pool, q, baseOpts(org, false))
            const granted = await runCustomQuery(pool, q, baseOpts(org, true))
            const moneyTotal = (groups: unknown): string => sum(JSON.stringify(groups).match(/-?\d+\.\d+/g) ?? [])
            assert.equal(cmp(moneyTotal(restricted.groups), moneyTotal(granted.groups)), 0, 'restricted money must tie to granted money')
            const text = JSON.stringify(granted.groups)
            assert.ok(text.includes(NET_A) && text.includes(NAME_A), 'granted control must see both employees')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "payroll confidentiality", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        type Authz = import('./authz.ts').Authz;
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { journalReport, generalLedger } = await import('./reports/ledger-reports.ts')
        const { transactionDetail } = await import('./reports/transaction-detail.ts')
        const { accountRegister, partyRegister, partnerStatement } = await import('./reports/registers.ts')
        const { entryDetail } = await import('./data.ts')
        const { executeReport } = await import('./custom-reports.ts')
        const { withReportAuthz } = await import('./report-execution-context.ts')
        const { PAYROLL_RESTRICTED_PARTY_LABEL } = await import('./payroll-confidentiality.ts')

        /**
         * PAYCONF: a reader with reports.read but WITHOUT payroll.read must not see
         * per-employee net pay through any ledger surface, while every total still
         * balances and payroll.read holders keep full detail.
         *
         * The fixture mirrors what the payroll engine posts: a pay-run projection
         * (origin 'document', source document kind pay_run) with per-employee
         * party-tagged net-pay credits, and a net-pay settlement (origin 'payroll',
         * same source document) with per-employee debits and cheque memos. The
         * net-pay payable is a `liability_payable` account — expressly allowed by the
         * payroll settings contract — so the AP register path is exercised too. A
         * vendor bill on the same control proves non-payroll party detail is
         * untouched.
         */

        const ALICE = 'Alice Anderson'
        const BOB = 'Bob Brown'

        async function seed() {
          const scratch = await withBypass(() => createScratchOrg())
          const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Payconf Controller', 'admin'))
          const fx = {
            ...scratch, actor,
            alice: randomUUID(), bob: randomUUID(),
            payRun: randomUUID(), bill: randomUUID(),
            e1: randomUUID(), e2: randomUUID(), e3: randomUUID(),
            wages: randomUUID(),
          }
          await withBypass(async () => {
            await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
              values (${fx.alice}, ${fx.orgId}, 'employee', ${ALICE}, ${fx.subsidiaryId}),
                     (${fx.bob}, ${fx.orgId}, 'employee', ${BOB}, ${fx.subsidiaryId})`)
            await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
              values (${fx.wages}, ${fx.orgId}, '6000', 'Wages', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
            await db.execute(sql`insert into documents
              (id, org_id, kind, status, document_number, subsidiary_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
              values (${fx.payRun}, ${fx.orgId}, 'pay_run', 'approved', 'PAY-001', ${fx.subsidiaryId}, ${fx.date}, 'CAD', '1', 0, 0, 0, ${fx.actor}),
                     (${fx.bill}, ${fx.orgId}, 'vendor_bill', 'approved', 'BILL-1', ${fx.subsidiaryId}, ${fx.date}, 'CAD', '1', 300, 0, 300, ${fx.actor})`)
            const entry = (id: string, number: string, origin: string, source: string) => db.execute(sql`insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
              values (${id}, ${fx.orgId}, ${fx.bookId}, ${fx.subsidiaryId}, ${number}, ${fx.date}, ${fx.periodId}, ${number}, 'draft', ${origin}, ${source})`)
            await entry(fx.e1, 'JE-PAYRUN', 'document', fx.payRun)
            await entry(fx.e2, 'JE-PAYD', 'payroll', fx.payRun)
            await entry(fx.e3, 'JE-BILL', 'document', fx.bill)
            // E1: run projection — wage debit, aggregate tax credit, per-employee net-pay credits.
            await db.execute(sql`insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
              values (${fx.orgId}, ${fx.e1}, 1, ${fx.wages}, ${fx.subsidiaryId}, null, '5000', 'CAD', '5000', '1', false, 'Wages'),
                     (${fx.orgId}, ${fx.e1}, 2, ${fx.accounts.taxOutput}, ${fx.subsidiaryId}, null, '-1000', 'CAD', '-1000', '1', false, 'Tax'),
                     (${fx.orgId}, ${fx.e1}, 3, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.alice}, '-1500', 'CAD', '-1500', '1', true, 'Net pay'),
                     (${fx.orgId}, ${fx.e1}, 4, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.bob}, '-2500', 'CAD', '-2500', '1', true, 'Net pay')`)
            // E2: settlement — per-employee debits with cheque memos, one bank credit.
            await db.execute(sql`insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
              values (${fx.orgId}, ${fx.e2}, 1, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.alice}, '1500', 'CAD', '1500', '1', true, 'Net pay PAY-001 · cheque 101'),
                     (${fx.orgId}, ${fx.e2}, 2, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.bob}, '2500', 'CAD', '2500', '1', true, 'Net pay PAY-001 · cheque 102'),
                     (${fx.orgId}, ${fx.e2}, 3, ${fx.accounts.bank}, ${fx.subsidiaryId}, null, '-4000', 'CAD', '-4000', '1', false, 'Net pay PAY-001')`)
            // E3: ordinary vendor bill — must never be masked.
            await db.execute(sql`insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
              values (${fx.orgId}, ${fx.e3}, 1, ${fx.accounts.freight}, ${fx.subsidiaryId}, ${fx.vendorId}, '300', 'CAD', '300', '1', false, 'Freight'),
                     (${fx.orgId}, ${fx.e3}, 2, ${fx.accounts.ap}, ${fx.subsidiaryId}, ${fx.vendorId}, '-300', 'CAD', '-300', '1', true, 'Freight')`)
            await db.execute(sql`update journal_entries set status = 'posted', posted_at = now()
              where org_id = ${fx.orgId} and id in (${fx.e1}, ${fx.e2}, ${fx.e3})`)
            await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${fx.e1}, posting_period_id = ${fx.periodId}
              where id = ${fx.payRun} and org_id = ${fx.orgId}`)
            await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${fx.e3}, posting_period_id = ${fx.periodId}
              where id = ${fx.bill} and org_id = ${fx.orgId}`)
          })
          return fx
        }

        function readerAuthz(fx: Awaited<ReturnType<typeof seed>>, permissions: string[]): Authz {
          return {
            user: {
              id: fx.actor, email: 'payconf@example.com', name: 'Payconf', roles: [],
              orgId: fx.orgId, envKind: 'production', productionOrgId: fx.orgId,
              isSuperAdmin: false, homeUserId: fx.actor, homeOrgId: fx.orgId,
            },
            permissions: new Set(permissions),
            allowedSubsidiaryIds: null,
          } as Authz
        }

        test('journal hides per-employee pay but balances; payroll.read keeps detail', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const { masked, full } = await withOrgContext(fx.orgId, async () => ({
              masked: await journalReport(fx.date, fx.date, { orgId: fx.orgId }),
              full: await journalReport(fx.date, fx.date, { orgId: fx.orgId, canSeePayroll: true }),
            }))
            const maskedText = JSON.stringify(masked)
            assert.ok(!maskedText.includes(ALICE) && !maskedText.includes(BOB), 'no employee names for restricted readers')
            assert.ok(!maskedText.includes('cheque'), 'no per-employee cheque memos for restricted readers')
            const e1 = masked.entries.find((e) => e.entryNumber === 'JE-PAYRUN')!
            const e2 = masked.entries.find((e) => e.entryNumber === 'JE-PAYD')!
            assert.equal(e1.totalDebit, '5000.0000')
            assert.equal(e2.totalDebit, '4000.0000')
            const e1Pay = e1.lines.filter((l) => l.accountName === 'Accounts Payable')
            assert.equal(e1Pay.length, 1)
            assert.equal(e1Pay[0]?.party, PAYROLL_RESTRICTED_PARTY_LABEL)
            assert.equal(e1Pay[0]?.memo, null)
            assert.equal(e1Pay[0]?.credit, '4000.0000')
            const e2Pay = e2.lines.filter((l) => l.accountName === 'Accounts Payable')
            assert.equal(e2Pay.length, 1)
            assert.equal(e2Pay[0]?.party, PAYROLL_RESTRICTED_PARTY_LABEL)
            assert.equal(e2Pay[0]?.debit, '4000.0000')
            // The vendor bill next door is untouched.
            const e3 = masked.entries.find((e) => e.entryNumber === 'JE-BILL')!
            assert.ok(e3.lines.every((l) => l.party !== null && l.party !== PAYROLL_RESTRICTED_PARTY_LABEL))
            // Full detail survives behind payroll.read.
            assert.ok(JSON.stringify(full).includes(ALICE) && JSON.stringify(full).includes('cheque 101'))
            assert.equal(full.entries.find((e) => e.entryNumber === 'JE-PAYRUN')!.lines.filter((l) => l.accountName === 'Accounts Payable').length, 2)
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })

        test('general ledger collapses payroll lines with exact balances', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const { masked, full } = await withOrgContext(fx.orgId, async () => ({
              masked: await generalLedger(fx.date, fx.date, { orgId: fx.orgId, accountId: fx.accounts.ap }),
              full: await generalLedger(fx.date, fx.date, { orgId: fx.orgId, accountId: fx.accounts.ap, canSeePayroll: true }),
            }))
            assert.equal(masked.accounts.length, 1)
            // E1 pair -> 1 line, E2 pair -> 1 line, vendor bill -> 1 line.
            assert.equal(masked.accounts[0]?.lines.length, 3)
            assert.equal(full.accounts[0]?.lines.length, 5)
            assert.equal(masked.accounts[0]?.closing, full.accounts[0]?.closing)
            assert.equal(masked.accounts[0]?.closing, '-300.0000')
            assert.ok(!JSON.stringify(masked).includes(ALICE) && !masked.accounts[0]?.lines.some((l) => l.memo?.includes('cheque')))
            assert.ok(masked.accounts[0]?.lines.some((l) => l.party === PAYROLL_RESTRICTED_PARTY_LABEL))
            assert.ok(JSON.stringify(full).includes(ALICE))
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })

        test('statement drill ties out with masked lines; payroll.read keeps detail', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const { masked, full } = await withOrgContext(fx.orgId, async () => ({
              masked: await transactionDetail({ accountIds: [fx.accounts.ap], from: fx.date, to: fx.date, mode: 'flow', orgId: fx.orgId }),
              full: await transactionDetail({ accountIds: [fx.accounts.ap], from: fx.date, to: fx.date, mode: 'flow', orgId: fx.orgId, canSeePayroll: true }),
            }))
            assert.equal(masked.net, full.net)
            assert.equal(masked.totalDebit, full.totalDebit)
            assert.equal(masked.totalCredit, full.totalCredit)
            assert.equal(masked.lines.length, 3)
            assert.equal(full.lines.length, 5)
            assert.ok(!JSON.stringify(masked).includes(ALICE) && !JSON.stringify(masked).includes('cheque'))
            assert.ok(JSON.stringify(full).includes(BOB))
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })

        test('account register masks payroll lines with an unchanged balance', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const { masked, full } = await withOrgContext(fx.orgId, async () => ({
              masked: await accountRegister(fx.orgId, fx.accounts.ap, 1, 0),
              full: await accountRegister(fx.orgId, fx.accounts.ap, 100, 0, undefined, null, undefined, true),
            }))
            assert.equal(masked.balance, '-300.0000')
            assert.equal(masked.balance, full.balance)
            assert.ok(!JSON.stringify(masked).includes(ALICE) && !JSON.stringify(masked).includes('cheque'))
            assert.deepEqual([masked.lines[0]?.party, masked.lines[0]?.amount], [PAYROLL_RESTRICTED_PARTY_LABEL, '-4000.0000'])
            assert.ok(JSON.stringify(full).includes(ALICE))
            // No party ids leak through the collapsed rows.
            assert.ok(!JSON.stringify(masked).includes(fx.alice) && !JSON.stringify(masked).includes(fx.bob))
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })

        test('entry detail collapses payroll lines; payroll.read keeps detail', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const { masked, full } = await withOrgContext(fx.orgId, async () => ({
              masked: await entryDetail(fx.orgId, fx.e2),
              full: await entryDetail(fx.orgId, fx.e2, null, true),
            }))
            assert.ok(masked.entry)
            assert.equal(masked.lines.length, 2)
            const pay = masked.lines.find((l) => l.account_name === 'Accounts Payable')!
            assert.equal(pay.party, PAYROLL_RESTRICTED_PARTY_LABEL)
            assert.equal(pay.memo, null)
            assert.equal(pay.amount, '4000.0000')
            assert.ok(!JSON.stringify(masked).includes(ALICE) && !JSON.stringify(masked).includes('cheque'))
            assert.ok(!JSON.stringify(masked).includes(fx.alice))
            assert.equal(full.lines.length, 3)
            assert.ok(JSON.stringify(full).includes('cheque 102'))
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })

        test('AP register remaps payroll parties with control-tying closings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const { masked, full } = await withOrgContext(fx.orgId, async () => ({
              masked: await partyRegister('ap', { from: fx.date, to: fx.date, orgId: fx.orgId }),
              full: await partyRegister('ap', { from: fx.date, to: fx.date, orgId: fx.orgId, canSeePayroll: true }),
            }))
            const names = masked.parties.map((p) => p.partyName)
            assert.ok(!names.includes(ALICE) && !names.includes(BOB), 'no employee sections for restricted readers')
            const total = (parties: typeof masked.parties): number =>
              parties.reduce((n, p) => n + Number(p.closing), 0)
            assert.equal(total(masked.parties), total(full.parties))
            assert.equal(total(masked.parties), -300)
            // The vendor section survives intact; the masked amounts sit unassigned.
            const vendor = masked.parties.find((p) => p.partyName !== null && p.partyId !== null)!
            assert.equal(vendor.closing, '-300.0000')
            const unassigned = masked.parties.find((p) => p.partyId === null)!
            assert.equal(unassigned.closing, '0.0000')
            // Full detail keeps per-employee sections that net to zero (settled).
            const alice = full.parties.find((p) => p.partyName === ALICE)!
            assert.equal(alice.lines.length, 2)
            assert.equal(alice.closing, '0.0000')
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })

        test('partner statement excludes payroll from the employee statement', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const { masked, full, vendorMasked } = await withOrgContext(fx.orgId, async () => ({
              masked: await partnerStatement(fx.alice, fx.orgId, { from: fx.date, to: fx.date, side: 'ap' }),
              full: await partnerStatement(fx.alice, fx.orgId, { from: fx.date, to: fx.date, side: 'ap', canSeePayroll: true }),
              vendorMasked: await partnerStatement(fx.vendorId, fx.orgId, { from: fx.date, to: fx.date, side: 'ap' }),
            }))
            assert.equal(masked.lines.length, 0)
            assert.equal(Number(masked.opening), 0)
            assert.equal(Number(masked.closing), 0)
            assert.equal(full.lines.length, 2)
            // The vendor statement is unaffected by the remap.
            assert.equal(vendorMasked.lines.length, 1)
            assert.equal(vendorMasked.closing, '-300.0000')
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })

        test('report-builder ledger lines mask identity and collapse payroll rows', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seed()
          try {
            const columns = ['posting_date', 'entry_number', 'account_name', 'party_name', 'memo', 'amount', 'entry_id', 'account_id']
            const run = (permissions: string[]) =>
              withReportAuthz(readerAuthz(fx, permissions), () =>
                withOrgContext(fx.orgId, () =>
                  // Empty labels: the Next request-scoped label localizer is
                  // unavailable in tests; every hook is optional.
                  executeReport(fx.orgId, { entity: 'ledger_lines', mode: 'rows', columns }, undefined, {})))
            const [masked, full] = await Promise.all([
              run(['reports.read']),
              run(['reports.read', 'payroll.read']),
            ])
            const maskedText = JSON.stringify(masked)
            assert.ok(!maskedText.includes(ALICE) && !maskedText.includes(BOB), 'no employee names in builder output')
            assert.ok(!maskedText.includes('cheque'), 'no cheque memos in builder output')
            assert.ok(!maskedText.includes(fx.alice), 'no employee ids in builder output')
            assert.ok(maskedText.includes(PAYROLL_RESTRICTED_PARTY_LABEL))
            const group = masked.groups[0]!
            const partyIdx = columns.indexOf('party_name')
            const amountIdx = columns.indexOf('amount')
            const entryIdx = columns.indexOf('entry_id')
            const payRows = group.rows.filter((row) => row[partyIdx] === PAYROLL_RESTRICTED_PARTY_LABEL)
            // One collapsed row per payroll (entry, account): E1-AP and E2-AP.
            assert.equal(payRows.length, 2)
            const e1 = payRows.find((row) => row[entryIdx] === fx.e1)!
            const e2 = payRows.find((row) => row[entryIdx] === fx.e2)!
            assert.equal(Number(e1[amountIdx]), -4000)
            assert.equal(Number(e2[amountIdx]), 4000)
            // Money still ties between the two grants.
            const sum = (rows: (string | number | null | undefined)[][]): number =>
              rows.reduce((n, row) => n + (row[amountIdx] == null ? 0 : Number(row[amountIdx])), 0)
            assert.equal(sum(group.rows), sum(full.groups[0]!.rows))
            // Full detail behind payroll.read.
            assert.ok(JSON.stringify(full).includes(ALICE))
            assert.ok(full.groups[0]!.rows.length > group.rows.length)
            // The vendor row keeps its party in both.
            assert.ok(group.rows.some((row) => String(row[partyIdx] ?? '').length > 0 && row[partyIdx] !== PAYROLL_RESTRICTED_PARTY_LABEL))
          } finally {
            await withBypass(() => dropScratchOrg(fx.orgId))
          }
        })
  } },
  { label: "payroll register income tax", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const test = (await import('node:test')).default;
        const { randomUUID } = await import('node:crypto');
        const { sql } = await import('drizzle-orm');
        const { db, pool } = await import('@openbooks/engine/src/platform/db.ts')
        const { withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg, seedWorkerEmployment } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { PAYROLL_COUNTRY_PACKS, eiColumnSystemKeys, employeeSocialInsuranceSystemKeys, packStatutoryComponents } = await import('@openbooks/engine/src/payroll/packs.ts')
        const { REPORT_ENTITY_MAP } = await import('@openbooks/reports')
        const { compileCustomQuery } = await import('@openbooks/reports')
        const { reportEntityCatalog } = await import('./custom-record-report-catalog')

        const catalogFor = (orgId: string) => {
          const userId = randomUUID()
          return reportEntityCatalog({
            user: { id: userId, email: 'register-fixture@example.test', name: 'Register fixture', orgId, roles: [], isSuperAdmin: false, homeUserId: userId, homeOrgId: orgId, productionOrgId: orgId, envKind: 'production' as const },
            permissions: new Set(['records.read']),
            allowedSubsidiaryIds: null,
          } as never)
        }

        /**
         * The payroll register read employee social insurance out of the stub
         * factors JSON as C + C2 + SS + MED + MED2 (cpp_fica) and EI (ei) — Canadian
         * and US engine internals. Eleven packs reported 0.00 beside a net that
         * reflected their contributions, and QPIP appeared in NEITHER bucket: real
         * withheld money with no column. Both columns now aggregate the
         * pack-declared set (every deduction assessed on earnings) from the stub
         * lines — `ei` the stated EI-family pair, `cpp_fica` every other key by
         * structural complement — with both columns and both labels untouched.
         */
        test('payroll register social buckets: eleven packs counted, QPIP folded into EI', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypass(() => createScratchOrg())
          try {
            const orgId = org.orgId
            assert.deepEqual(eiColumnSystemKeys(), ['ei', 'qpip'])
            const liveSocial = employeeSocialInsuranceSystemKeys()
            for (const key of ['qpip', 'zus_emeryt', 'nic', 'ss', 'inps']) {
              assert.ok(liveSocial.includes(key), `${key} is counted on the day its pack registers`)
            }

            // The shipped wiring binds the live pack sets into the executed catalog.
            // Reads run tenant-scoped (withOrgContext): the register must work under
            // real RLS, and fixture writes run in trusted bypass (withBypass) —
            // importing the catalog pulls the web request-org resolver, which denies
            // outside a request, so bare pooled writes would die on RLS here.
            const catalog = await withOrgContext(orgId, () => catalogFor(orgId))
            assert.match(catalog.pay_stubs!.columns.find((c) => c.key === 'cpp_fica')!.expr, /cpp_fica_lines/)
            assert.match(catalog.pay_stubs!.columns.find((c) => c.key === 'ei')!.expr, /ei_lines/)
            assert.equal(catalog.pay_stubs!.columns.find((c) => c.key === 'cpp_fica')!.label, 'CPP / FICA (employee)')
            assert.equal(catalog.pay_stubs!.columns.find((c) => c.key === 'ei')!.label, 'EI (employee)')
            assert.ok(catalog.pay_stubs!.from.includes(`'pit'`), 'executed catalog inlines the live key set')
            assert.ok(catalog.pay_stubs!.from.includes(`'qpip'`), 'QPIP rides the executed derivation')

            // pay_stubs.employment_id is NOT NULL: every stub employee carries the
            // HRM employment the payroll engine requires next to the profile.
            const employee = async (name: string) => {
              const id = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
                values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`)
              const employmentId = await seedWorkerEmployment(orgId, id, org.subsidiaryId)
              return { id, employmentId }
            }
            const component = async (code: string, name: string, kind: string, systemKey: string, country: string) => {
              const id = randomUUID()
              await db.execute(sql`insert into pay_components (id, org_id, code, name, kind, system_key, country, sequence)
                values (${id}, ${orgId}, ${code}, ${name}, ${kind}, ${systemKey}, ${country}, 100)`)
              return id
            }
            // One shared run; each stub carries production-shaped data: line amounts
            // equal the computed withholding the factors trace (run-stub-records
            // writes both from the same calculation; quebec.integration asserts
            // income_tax line == T4127 totalTax == T + TB).
            await withBypass(async () => {
            const scheduleId = randomUUID()
            await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
              values (${scheduleId}, ${orgId}, 'Monthly', 'monthly', 12, '2026-01-31')`)
            const docId = randomUUID()
            await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, currency, status)
              values (${docId}, ${orgId}, 'pay_run', 'PR-REG-001', '2026-07-31', 'CAD', 'draft')`)
            await db.execute(sql`insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
              values (${docId}, ${orgId}, ${scheduleId}, '2026-07-01', '2026-07-31', '2026-07-31', 2026, 'committed')`)

            const stub = async (
              name: string, province: string, currency: string, gross: string, net: string,
              factors: Record<string, string>, lines: { componentId: string; kind: string; description: string; amount: string }[],
            ) => {
              const stubId = randomUUID()
              const emp = await employee(name)
              await db.execute(sql`insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id, province,
                                   periods_per_year, pay_date, tax_year, currency_code, gross, net_pay, employer_cost, factors)
                values (${stubId}, ${orgId}, ${docId}, ${emp.id}, ${emp.employmentId}, ${province},
                        12, '2026-07-31', 2026, ${currency}, ${gross}, ${net}, ${gross}, ${JSON.stringify(factors)}::jsonb)`)
              let sequence = 100
              for (const line of lines) {
                await db.execute(sql`insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount, sequence)
                  values (${orgId}, ${stubId}, ${line.componentId}, ${line.kind}, ${line.description}, ${line.amount}, ${sequence})`)
                sequence += 10
              }
              return name
            }

            const pl = {
              pit: await component('PIT', 'Zaliczka na podatek dochodowy (PIT)', 'deduction', 'pit', 'PL'),
              emeryt: await component('EMERYT', 'Skladka emerytalna (pracownik)', 'deduction', 'zus_emeryt', 'PL'),
            }
            const ca = {
              tax: await component('TAX', 'Income tax', 'deduction', 'income_tax', 'CA'),
              qctax: await component('QCTAX', 'Quebec income tax', 'deduction', 'qc_income_tax', 'CA'),
              cpp: await component('CPP', 'CPP', 'deduction', 'cpp', 'CA'),
              cppEr: await component('CPP-ER', 'CPP (employer)', 'employer_contribution', 'cpp', 'CA'),
              ei: await component('EI', 'EI', 'deduction', 'ei', 'CA'),
              eiEr: await component('EI-ER', 'EI (employer)', 'employer_contribution', 'ei', 'CA'),
              qpip: await component('QPIP', 'QPIP', 'deduction', 'qpip', 'CA'),
            }
            const us = {
              fit: await component('FIT', 'Federal income tax', 'deduction', 'fit', 'US'),
              sit: await component('SIT', 'State income tax', 'deduction', 'state_income_tax', 'US'),
              ss: await component('SS', 'Social Security', 'deduction', 'ss', 'US'),
              med: await component('MED', 'Medicare', 'deduction', 'medicare', 'US'),
            }
            const L = (componentId: string, description: string, amount: string, kind = 'deduction') =>
              ({ componentId, kind, description, amount })

            // Poland: ZUS contributions beside a net that reflects them, no CA/US
            // factor anywhere — the old buckets printed 0.00 and 0.00.
            await stub('Jan Kowalski', 'MZ', 'PLN', '10000.0000', '7000.0000', {},
              [L(pl.pit, 'Zaliczka na podatek dochodowy (PIT)', '498.0000'),
               L(pl.emeryt, 'Skladka emerytalna (pracownik)', '1500.0000')])
            // Ontario, periodic only: the old buckets were already complete here.
            await stub('Alice Ontario', 'ON', 'CAD', '5000.0000', '3500.0000',
              { C: '250.0000', EI: '80.0000', T: '1234.5600' },
              [L(ca.tax, 'Income tax', '1234.5600'), L(ca.cpp, 'CPP', '250.0000'), L(ca.ei, 'EI', '80.0000')])
            // Ontario with a bonus.
            await stub('Bob Bonus', 'ON', 'CAD', '8000.0000', '5000.0000',
              { C: '300.0000', EI: '90.0000', T: '1500.0000', TB: '400.0000' },
              [L(ca.tax, 'Income tax', '1900.0000'), L(ca.cpp, 'CPP', '300.0000'), L(ca.ei, 'EI', '90.0000')])
            // US federal only: the old buckets were already complete here.
            await stub('Carol Federal', 'CA', 'USD', '6000.0000', '4500.0000',
              { SS: '372.0000', MED: '87.0000', FIT: '800.0000' },
              [L(us.fit, 'Federal income tax', '800.0000'), L(us.ss, 'Social Security', '372.0000'),
               L(us.med, 'Medicare', '87.0000')])
            // Quebec: QPIP was in NO register column at all (250 + 65 = 315 shown of
            // 345 withheld). The employer-share lines ride the same system keys as
            // production pushStatutory posts them and must stay out of both totals.
            await stub('Danielle Quebec', 'QC', 'CAD', '5000.0000', '3200.0000',
              { C: '250.0000', EI: '65.0000', T: '900.0000', QC_A: '4800.0000' },
              [L(ca.tax, 'Income tax', '900.0000'), L(ca.qctax, 'Quebec income tax', '600.0000'),
               L(ca.cpp, 'CPP', '250.0000'), L(ca.cppEr, 'CPP (employer)', '111.1100', 'employer_contribution'),
               L(ca.ei, 'EI', '65.0000'), L(ca.eiEr, 'EI (employer)', '22.2200', 'employer_contribution'),
               L(ca.qpip, 'QPIP', '30.0000')])
            // US with state tax.
            await stub('Eddie State', 'CA', 'USD', '6000.0000', '4200.0000',
              { SS: '372.0000', MED: '87.0000', FIT: '800.0000', SIT_CA: '300.0000' },
              [L(us.fit, 'Federal income tax', '800.0000'), L(us.sit, 'California PIT', '300.0000'),
               L(us.ss, 'Social Security', '372.0000'), L(us.med, 'Medicare', '87.0000')])
            })

            const query = {
              entity: 'pay_stubs', mode: 'rows' as const,
              columns: ['employee', 'gross', 'cpp_fica', 'ei', 'income_tax', 'net_pay', 'employer_cost'],
              breakouts: [], measures: [], filters: null, groupBy: null,
              sorts: [{ column: 'employee', direction: 'asc' as const }], limit: 100,
            }
            const run = async (entity: (typeof REPORT_ENTITY_MAP)[string]) => {
              const compiled = compileCustomQuery(entity, { ...query }, orgId, { maxRows: 100 })
              return (await pool.query(compiled.text, compiled.values as unknown[])).rows as Record<string, string>[]
            }
            const legacy = await withOrgContext(orgId, () => run(REPORT_ENTITY_MAP.pay_stubs!))
            const bound = await withOrgContext(orgId, () => run(catalog.pay_stubs!))
            const row = (rows: Record<string, string>[], name: string) => rows.find((r) => r.employee === name)!

            // Income-tax column (from 6d006fd95, pinned again here): parity where the
            // old expression was complete, corrections where it dropped provincial /
            // state withholding.
            assert.equal(Number(row(legacy, 'Jan Kowalski').income_tax), 0)
            assert.equal(Number(row(bound, 'Jan Kowalski').income_tax), 498)
            for (const name of ['Alice Ontario', 'Bob Bonus', 'Carol Federal']) {
              assert.equal(Number(row(bound, name).income_tax), Number(row(legacy, name).income_tax), `${name} parity`)
            }
            assert.equal(Number(row(legacy, 'Danielle Quebec').income_tax), 900)
            assert.equal(Number(row(bound, 'Danielle Quebec').income_tax), 1500)
            assert.equal(Number(row(legacy, 'Eddie State').income_tax), 800)
            assert.equal(Number(row(bound, 'Eddie State').income_tax), 1100)

            // Social buckets before/after, every figure announced. Columns and
            // labels are unchanged; only the derivation moves.
            //
            //   Jan Kowalski    cpp_fica   0.00 -> 1500.00   ZUS, previously invisible
            //                   ei         0.00 ->    0.00
            //   Alice Ontario   cpp_fica 250.00 ->  250.00   parity (CPP)
            //                   ei        80.00 ->   80.00   parity
            //   Bob Bonus       cpp_fica 300.00 ->  300.00   parity
            //                   ei        90.00 ->   90.00   parity
            //   Carol Federal   cpp_fica 459.00 ->  459.00   parity (372 SS + 87 MED)
            //                   ei         0.00 ->    0.00
            //   Danielle Quebec cpp_fica 250.00 ->  250.00   parity (QPIP is not CPP)
            //                   ei        65.00 ->   95.00   +30.00 QPIP newly counted
            //   Eddie State     cpp_fica 459.00 ->  459.00   parity
            //                   ei         0.00 ->    0.00
            for (const [name, cppFica, ei, boundCpp, boundEi] of [
              ['Jan Kowalski', 0, 0, 1500, 0],
              ['Alice Ontario', 250, 80, 250, 80],
              ['Bob Bonus', 300, 90, 300, 90],
              ['Carol Federal', 459, 0, 459, 0],
              ['Danielle Quebec', 250, 65, 250, 95],
              ['Eddie State', 459, 0, 459, 0],
            ] as const) {
              assert.equal(Number(row(legacy, name).cpp_fica), cppFica, `${name} legacy cpp_fica`)
              assert.equal(Number(row(legacy, name).ei), ei, `${name} legacy ei`)
              assert.equal(Number(row(bound, name).cpp_fica), boundCpp, `${name} bound cpp_fica`)
              assert.equal(Number(row(bound, name).ei), boundEi, `${name} bound ei`)
            }
            // QPIP, named explicitly: 30.00 withheld, present in no legacy column
            // (250 + 65 = 315 of 345 withheld), present in the EI column now. The
            // employer shares on the same keys (111.11 + 22.22) stay out of both.
            assert.equal(
              Number(row(legacy, 'Danielle Quebec').cpp_fica) + Number(row(legacy, 'Danielle Quebec').ei),
              315,
            )
            assert.equal(Number(row(bound, 'Danielle Quebec').cpp_fica) + Number(row(bound, 'Danielle Quebec').ei), 345)

            // Still untouched on every stub: gross, income tax parity cases above,
            // net, employer cost.
            // Stated twice, not looped: the static checker cannot follow the alias
            // through `[legacy, bound]`, and an exemption would also cover the next
            // real vacuum in this file.
            assert.equal(legacy.length, 6)
            assert.equal(bound.length, 6)
            for (const r of legacy) {
              const b = row(bound, r.employee!)
              for (const column of ['gross', 'net_pay', 'employer_cost']) {
                assert.equal(Number(b[column]), Number(r[column]), `${r.employee}.${column} untouched`)
              }
            }

            // Summarize mode (employee-totals built-in shape) sums the bound columns.
            const summaryQuery = {
              entity: 'pay_stubs', mode: 'summarize' as const, columns: [] as string[],
              breakouts: [{ column: 'employee' }],
              measures: [
                { fn: 'sum' as const, column: 'income_tax', label: 'Income tax withheld' },
                { fn: 'sum' as const, column: 'cpp_fica', label: 'CPP / FICA (employee)' },
                { fn: 'sum' as const, column: 'ei', label: 'EI (employee)' },
              ],
              filters: null, groupBy: null, limit: 100,
            }
            const summaryCompiled = compileCustomQuery(catalog.pay_stubs!, summaryQuery, orgId, { maxRows: 100 })
            const summary = await withOrgContext(orgId, () => pool.query(summaryCompiled.text, summaryCompiled.values as unknown[]))
            const totals = Object.fromEntries(summary.rows.map((r) => [r.d0, [Number(r.m0), Number(r.m1), Number(r.m2)]]))
            assert.deepEqual(totals['Jan Kowalski'], [498, 1500, 0])
            assert.deepEqual(totals['Alice Ontario'], [1234.56, 250, 80])
            assert.deepEqual(totals['Danielle Quebec'], [1500, 250, 95])
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        const COVERAGE_CURRENCY: Record<string, string> = {
          CA: 'CAD', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', IE: 'EUR', AU: 'AUD',
          IT: 'EUR', NL: 'EUR', ES: 'EUR', SG: 'SGD', JP: 'JPY', PL: 'PLN', BR: 'BRL',
        }

        /**
         * Per-pack "no declared deduction is invisible": for every registered pack,
         * a stub carrying one line per statutory component the pack declares —
         * posted with the declared kind, at a distinct whole-dollar amount — must
         * have every deduction dollar appear in some register column. The
         * expectation is re-derived from the declarations per component (never by
         * calling the key-set functions under test), so a pack added later fails
         * this test rather than silently reporting zero; the register binds the
         * live key sets, so a derivation that stops following the declarations
         * fails it too. The EI rule under test: ei/ei-family lines in `ei`,
         * every other earnings-assessed deduction in `cpp_fica`.
         */
        test('payroll register: every statutory employee deduction appears in some column, per pack', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypass(() => createScratchOrg())
          try {
            const orgId = org.orgId
            const catalog = await withOrgContext(orgId, () => catalogFor(orgId))
            const boundEntity = catalog.pay_stubs!
            assert.match(boundEntity.columns.find((c) => c.key === 'cpp_fica')!.expr, /cpp_fica_lines/)
            assert.match(boundEntity.columns.find((c) => c.key === 'ei')!.expr, /ei_lines/)
            assert.match(boundEntity.columns.find((c) => c.key === 'income_tax')!.expr, /income_tax_lines/)
            // The shipped wiring inlines every declared deduction key: a key the
            // SQL does not name is a column that cannot see it.
            const declaredDeductionKeys = new Set<string>()
            for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
              for (const component of packStatutoryComponents(pack.country)) {
                if (component.kind === 'deduction') declaredDeductionKeys.add(component.systemKey)
              }
            }
            assert.ok(declaredDeductionKeys.size > 0)
            for (const key of declaredDeductionKeys) {
              assert.ok(boundEntity.from.includes(`'${key}'`), `executed SQL names ${key}`)
            }
            // …and every named key sits in exactly one of the two social joins:
            // double-named money would double-count, unnamed money would vanish.
            // Income-ness comes from the declarations, not the function under test.
            const incomeKeys = new Set<string>()
            for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
              for (const component of packStatutoryComponents(pack.country)) {
                if (component.kind === 'deduction' && component.assessedOn === 'taxable_income') {
                  incomeKeys.add(component.systemKey)
                }
              }
            }
            const cppJoin = boundEntity.from.slice(0, boundEntity.from.indexOf(') cpp_fica_lines on true'))
            const eiJoin = boundEntity.from.slice(boundEntity.from.indexOf(') cpp_fica_lines on true'))
            for (const key of declaredDeductionKeys) {
              if (!incomeKeys.has(key)) {
                assert.ok(
                  cppJoin.includes(`'${key}'`) !== eiJoin.includes(`'${key}'`),
                  `${key} sits in exactly one social join`,
                )
              }
            }

            let dollars = 0
            const expectedByEmployee: Record<string, { income: number; cpp: number; ei: number; deductions: number }> = {}
            const scheduleId = randomUUID()
            await withBypass(async () => {
            await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
              values (${scheduleId}, ${orgId}, 'Monthly', 'monthly', 12, '2026-01-31')`)
            const docId = randomUUID()
            await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, currency, status)
              values (${docId}, ${orgId}, 'pay_run', 'PR-REG-COVERAGE', '2026-07-31', 'CAD', 'draft')`)
            await db.execute(sql`insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
              values (${docId}, ${orgId}, ${scheduleId}, '2026-07-01', '2026-07-31', '2026-07-31', 2026, 'committed')`)

            // One stub per pack; every statutory component gets a line at a distinct
            // whole-dollar amount with the kind the pack declares for it — the shape
            // pushStatutory posts in production, including employer shares under
            // shared keys and refundable credits.
            for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
              const country = pack.country
              const name = `Coverage ${country}`
              const expected = { income: 0, cpp: 0, ei: 0, deductions: 0 }
              const partyId = randomUUID()
              await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
                values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`)
              const employmentId = await seedWorkerEmployment(orgId, partyId, org.subsidiaryId)
              const stubId = randomUUID()
              await db.execute(sql`insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id, province,
                                   periods_per_year, pay_date, tax_year, currency_code, gross, net_pay, employer_cost, factors)
                values (${stubId}, ${orgId}, ${docId}, ${partyId}, ${employmentId}, ${country},
                        12, '2026-07-31', 2026, ${COVERAGE_CURRENCY[country]}, '100000.0000', '60000.0000', '100000.0000', '{}'::jsonb)`)
              let sequence = 100
              for (const component of packStatutoryComponents(country)) {
                dollars += 1
                const componentId = randomUUID()
                await db.execute(sql`insert into pay_components (id, org_id, code, name, kind, system_key, country, sequence)
                  values (${componentId}, ${orgId}, ${`${country}_${component.code}`}, ${component.name}, ${component.kind}, ${component.systemKey}, ${country}, 100)`)
                await db.execute(sql`insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount, sequence)
                  values (${orgId}, ${stubId}, ${componentId}, ${component.kind}, ${component.name}, ${`${dollars}.0000`}, ${sequence})`)
                sequence += 10
                // Re-derived from the declarations, not from the functions under
                // test: this is the independent expectation the wiring must meet.
                // The EI rule as the register applies it: the ei/qpip pair lands in
                // `ei`, every other earnings-assessed deduction in `cpp_fica`.
                if (component.kind === 'deduction') {
                  expected.deductions += dollars
                  if (component.assessedOn === 'taxable_income') expected.income += dollars
                  else if (component.systemKey === 'ei' || component.systemKey === 'qpip') expected.ei += dollars
                  else expected.cpp += dollars
                }
              }
              expectedByEmployee[name] = expected
            }
            })

            const query = {
              entity: 'pay_stubs', mode: 'rows' as const,
              columns: ['employee', 'income_tax', 'cpp_fica', 'ei'],
              breakouts: [], measures: [], filters: null, groupBy: null,
              sorts: [{ column: 'employee', direction: 'asc' as const }], limit: 100,
            }
            const run = async (entity: (typeof REPORT_ENTITY_MAP)[string]) => {
              const compiled = compileCustomQuery(entity, { ...query }, orgId, { maxRows: 100 })
              return (await pool.query(compiled.text, compiled.values as unknown[])).rows as Record<string, string>[]
            }
            // Absolute floor, established once and not from the thing under test:
            // an empty or shrunken registry would make every row-count assertion
            // below pass vacuously, so the guard against it must not be expressed
            // in terms of it.
            const packCount = Object.keys(PAYROLL_COUNTRY_PACKS).length
            assert.ok(packCount >= 14, `the pack registry holds ${packCount} packs — an empty or shrunken registry makes every `
              + 'row-count assertion below pass vacuously')
            const bound = await withOrgContext(orgId, () => run(boundEntity))
            assert.equal(bound.length, packCount)
            for (const [name, expected] of Object.entries(expectedByEmployee)) {
              const found = bound.find((r) => r.employee === name)!
              assert.equal(Number(found.income_tax), expected.income, `${name}: income_tax`)
              assert.equal(Number(found.cpp_fica), expected.cpp, `${name}: cpp_fica`)
              assert.equal(Number(found.ei), expected.ei, `${name}: ei`)
              // The assertion that would have caught all three defects: every
              // declared deduction dollar is visible in some register column, and
              // the three buckets partition it exactly (a shared key double-counted
              // would exceed the total here).
              assert.equal(
                Number(found.income_tax) + Number(found.cpp_fica) + Number(found.ei),
                expected.deductions,
                `${name}: no declared deduction invisible, none double-counted`,
              )
            }
            // Australia and the Netherlands correctly have no employee social
            // insurance: their packs declare no earnings-assessed deduction, so the
            // expected figures re-derived above are 0 — correctly nil, not silently
            // zero. Only Canada has EI-family lines; every other pack's social total
            // sits entirely in cpp_fica by the stated rule.
            for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
              const expected = expectedByEmployee[`Coverage ${country}`]!
              if (country === 'AU' || country === 'NL') {
                assert.equal(expected.cpp, 0, `${country} declares no employee social insurance`)
                assert.equal(expected.ei, 0, `${country} declares no employee social insurance`)
              } else {
                assert.ok(expected.cpp + expected.ei > 0, `${country} has a positive employee social total`)
              }
              if (country === 'CA') assert.ok(expected.ei > 0, 'CA has EI-family lines')
              else assert.equal(expected.ei, 0, `only CA packs EI-family lines, not ${country}`)
            }

            // Red-proof, generalized: the legacy factor expressions see NOTHING on
            // these stubs (no CA/US labels anywhere), while the bound register sees
            // every dollar the packs declare.
            const legacyQuery = { ...query, columns: ['employee', 'income_tax', 'cpp_fica', 'ei'] }
            const legacyCompiled = compileCustomQuery(REPORT_ENTITY_MAP.pay_stubs!, { ...legacyQuery }, orgId, { maxRows: 100 })
            const legacy = (await withOrgContext(orgId, () => pool.query(legacyCompiled.text, legacyCompiled.values as unknown[]))).rows as Record<string, string>[]
            assert.equal(legacy.length, packCount,
              'the legacy query must return a row per pack: an empty result set would make the blindness assertions below pass by absence')
            for (const r of legacy) {
              assert.equal(Number(r.income_tax), 0, `${r.employee}: legacy income_tax blind`)
              assert.equal(Number(r.cpp_fica), 0, `${r.employee}: legacy cpp_fica blind`)
              assert.equal(Number(r.ei), 0, `${r.employee}: legacy ei blind`)
            }
            const boundDeductions = bound.reduce((sum, r) => sum + Number(r.income_tax) + Number(r.cpp_fica) + Number(r.ei), 0)
            const expectedDeductions = Object.values(expectedByEmployee).reduce((sum, e) => sum + e.deductions, 0)
            assert.ok(expectedDeductions > 0)
            assert.equal(boundDeductions, expectedDeductions)
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "ledger payroll collapse", register: async () => {
        const { pathToFileURL } = await import('node:url');
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const test = (await import('node:test')).default;
        const { randomUUID } = await import('node:crypto');
        /**
         * PAYCONF-c/d/e (collapse semantics): the interactive journal and GL account
         * detail collapse payroll legs per (entry, account) in the query itself —
         * before any order or limit — so a reader without payroll.read sees the
         * restricted label and entry totals but no employee name and no per-employee
         * amount. Balances tie out exactly; a reader WITH the grant sees everything
         * unchanged.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { generalLedger, journalReport } = (await import(root + 'web/lib/reports/ledger-reports.ts')) as typeof import('@/lib/reports/ledger-reports.ts')
        const { PAYROLL_RESTRICTED_PARTY_LABEL } = (await import(root + 'web/lib/payroll-confidentiality.ts')) as typeof import('@/lib/payroll-confidentiality.ts')

        type Org = Awaited<ReturnType<typeof createScratchOrg>>

        const NET_A = '4842.17'
        const NET_B = '5210.44'
        const NAME_A = 'Avery Employee'
        const NAME_B = 'Blake Employee'

        async function seedPayroll(org: Org) {
          return withBypassContext(async () => {
          const empA = randomUUID()
          const empB = randomUUID()
          const employees = await db.execute<{ id: string }>(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
            values (${empA}, ${org.orgId}, 'employee', ${NAME_A}, ${org.subsidiaryId}),
                   (${empB}, ${org.orgId}, 'employee', ${NAME_B}, ${org.subsidiaryId}) returning id`)
          assert.deepEqual(employees.rows.map(row => row.id).sort(), [empA, empB].sort(), 'payroll ledger employees are stored')
          const payDoc = randomUUID()
          await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, subsidiary_id, currency, subtotal, tax_total, total, fx_rate, status)
            values (${payDoc}, ${org.orgId}, 'pay_run', 'PAY-1', ${org.date}, ${org.date}, ${org.subsidiaryId}, 'USD', 0, 0, 10052.61, 1, 'approved')`)
          const entryId = randomUUID()
          await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
            values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'JE-PAY-1', ${org.date}, ${org.periodId}, 'Pay run PAY-1', 'draft', 'document', ${payDoc})`)
          await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
            values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${empA}, true, -4842.17, 'USD', -4842.17, 1, ${org.date}),
                   (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, ${empB}, true, -5210.44, 'USD', -5210.44, 1, ${org.date}),
                   (${randomUUID()}, ${org.orgId}, ${entryId}, 3, ${org.accounts.cogs}, ${org.subsidiaryId}, null, false, 10052.61, 'USD', 10052.61, 1, ${org.date})`)
          const posted = await db.execute<{ id: string }>(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId} returning id`)
          assert.deepEqual(posted.rows.map(row => row.id), [entryId], 'payroll ledger journal is posted once')
          })
        }

        function leakedIdentity(payload: unknown): string | null {
          const text = JSON.stringify(payload)
          for (const secret of [NAME_A, NAME_B]) {
            if (text.includes(secret)) return secret
          }
          return null
        }

        function leakedAmount(payload: unknown): string | null {
          const text = JSON.stringify(payload)
          for (const secret of [NET_A, NET_B]) {
            if (text.includes(secret)) return secret
          }
          return null
        }

        test('journal collapses the pay-run entry without the grant', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            const base = { dims: {}, orgId: org.orgId, bookId: org.bookId }
            const hidden = await withBypassContext(() => journalReport(org.date, org.date, { ...base, canSeePayroll: false }))
            assert.equal(leakedIdentity(hidden.entries), null, 'journal lines leaked an individual identity')
            assert.equal(leakedAmount(hidden.entries), null, 'journal lines leaked an individual amount')
            assert.ok(JSON.stringify(hidden.entries).includes(PAYROLL_RESTRICTED_PARTY_LABEL))

            const shown = await withBypassContext(() => journalReport(org.date, org.date, { ...base, canSeePayroll: true }))
            const text = JSON.stringify(shown.entries)
            assert.ok(text.includes(NET_A) && text.includes(NAME_A), 'granted journal must show both employees')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('GL collapses pay-run lines but keeps exact balances without the grant', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            await withBypassContext(() => seedPayroll(org))
            const base = { accountId: org.accounts.ap, dims: {}, orgId: org.orgId, bookId: org.bookId }
            const hidden = await withBypassContext(() => generalLedger(org.date, org.date, { ...base, canSeePayroll: false }))
            assert.equal(leakedIdentity(hidden.accounts), null, 'GL lines leaked an individual identity')
            assert.equal(leakedAmount(hidden.accounts), null, 'GL lines leaked an individual amount')
            // The payable account still lists with its full closing balance.
            const ap = hidden.accounts.find((a) => a.id === org.accounts.ap)
            assert.ok(ap, 'the payable account must still list with its balances')
            assert.equal(ap!.closing, '-10052.6100')
            // Balances tie with the granted reader's.
            const shown = await withBypassContext(() => generalLedger(org.date, org.date, { ...base, canSeePayroll: true }))
            const shownAp = shown.accounts.find((a) => a.id === org.accounts.ap)
            assert.equal(shownAp!.closing, ap!.closing, 'restricted balances must tie to granted balances')
            assert.ok(JSON.stringify(shown.accounts).includes(NET_B), 'granted GL must show employee lines')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "year earnings", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { balanceSheetView } = await import('./statement-matrix.ts')
        const { balanceSheet, trialBalance } = await import('./reports/statements.ts')
        const { generalLedger } = await import('./reports/ledger-reports.ts')
        const { decimalAdd, decimalIsZero } = await import('./statement-format.ts')
        const {
          COMPUTED_CURRENT_YEAR_EARNINGS_ID,
          COMPUTED_RETAINED_EARNINGS_PRIOR_ID,
        } = await import('./computed-earnings.ts')

        const labels = {
          assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity',
          totalAssets: 'Total assets', totalLiabilities: 'Total liabilities', totalEquity: 'Total equity',
          retainedEarningsPrior: 'Retained earnings (prior years)',
          currentYearEarnings: 'Current year earnings',
          translationAdjustment: 'Translation adjustment',
          liabilitiesAndEquity: 'Liabilities and equity',
          totalOf: (s: string) => `Total ${s}`,
        }

        async function fiscalCalendarId(orgId: string, periodId: string): Promise<string> {
          const row = (await db.execute<{ fiscal_calendar_id: string }>(sql`
            select fiscal_calendar_id from accounting_periods
             where id = ${periodId} and org_id = ${orgId}`)).rows[0]
          assert.ok(row, 'scratch period has a fiscal calendar')
          return row.fiscal_calendar_id
        }

        async function insertPeriod(args: {
          orgId: string
          calendarId: string
          year: number
          number: number
          name: string
          from: string
          to: string
        }): Promise<string> {
          const id = randomUUID()
          await db.execute(sql`
            insert into accounting_periods
              (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
            values (${id}, ${args.orgId}, ${args.calendarId}, ${args.year}, ${args.number},
                    ${args.name}, ${args.from}, ${args.to}, false)`)
          return id
        }

        async function post(args: {
          orgId: string
          bookId: string
          subsidiaryId: string
          periodId: string
          date: string
          debit: string
          credit: string
          amount: string
          tag: string
        }): Promise<void> {
          const entry = randomUUID()
          // Hoisted out of the insert below: a nested template literal inside an
          // interpolation desynchronizes the bypass-scope ratchet's parser, which
          // then ends this helper's body early and reports the status flip as an
          // unwrapped top-level write. Same SQL bytes, scanner-visible shape.
          const negated = `-${args.amount}`
          await db.execute(sql`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
            values (${entry}, ${args.orgId}, ${args.bookId}, ${args.subsidiaryId},
                    ${args.tag}, ${args.date}, ${args.periodId}, ${args.tag}, 'draft', 'manual')`)
          await db.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
            values (${args.orgId}, ${entry}, 1, ${args.debit}, ${args.subsidiaryId}, ${args.amount}, 'CAD', ${args.amount}, '1'),
                   (${args.orgId}, ${entry}, 2, ${args.credit}, ${args.subsidiaryId}, ${negated}, 'CAD', ${negated}, '1')`)
          // Runs in the caller's bypass scope, NOT a nested withBypassContext: the
          // inserts above inherit the outer withBypass, and opening a second
          // mechanism inside it lost the scope, so this UPDATE matched zero rows.
          // RLS filters an UPDATE, it does not raise — so the seed silently left
          // every entry in 'draft' and the statements correctly reported nothing.
          // Asserting the row count is what turns that back into a failure.
          const posted = await db.execute(sql`
            update journal_entries set status = 'posted', posted_at = now()
             where id = ${entry} returning id`)
          assert.equal(posted.rows.length, 1, `seed failed to post entry ${args.tag}`)
        }

        function findLine(view: Awaited<ReturnType<typeof balanceSheetView>>, label: string) {
          const line = view.lines.find((row) => row.label === label)
          assert.ok(line, `missing ${label}`)
          return line
        }

        test('year-aware earnings split prior-year P&L from FYTD on BS, TB, and GL', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            await withBypass(async () => {
              const calendarId = await fiscalCalendarId(scratch.orgId, scratch.periodId)
              const priorPeriodId = await insertPeriod({
                orgId: scratch.orgId, calendarId, year: 2025, number: 12,
                name: '2025-12', from: '2025-12-01', to: '2025-12-31',
              })
              await post({
                orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
                periodId: priorPeriodId, date: '2025-12-15',
                debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
                amount: '80.0000', tag: 'YE-PRIOR',
              })
              await post({
                orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
                periodId: scratch.periodId, date: scratch.date,
                debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
                amount: '25.0000', tag: 'YE-CURRENT',
              })
            })

            const bs = await withBypassContext(() => balanceSheet(scratch.date, scratch.orgId))
            const prior = bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)
            const current = bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)
            assert.equal(prior?.balance, '80.0000')
            assert.equal(current?.balance, '25.0000')
            assert.equal(bs.totalEquity, decimalAdd(prior!.balance, current!.balance))

            const view = await withBypassContext(() => balanceSheetView(
              { from: '2026-07-01', to: scratch.date }, 'July 2026', labels, { orgId: scratch.orgId },
            ))
            const priorLine = findLine(view, 'Retained earnings (prior years)')
            const currentLine = findLine(view, 'Current year earnings')
            assert.equal(priorLine.values?.[0], '80.0000')
            assert.equal(currentLine.values?.[0], '25.0000')
            assert.deepEqual(priorLine.drillWindows?.[0], {
              from: null, to: '2025-12-31', mode: 'balance',
            })
            assert.deepEqual(currentLine.drillWindows?.[0], {
              from: '2026-01-01', to: scratch.date, mode: 'flow',
            })

            const tb = await withBypassContext(() => trialBalance(scratch.date, undefined, scratch.orgId))
            const tbRevenue = tb.find((row) => row.id === scratch.accounts.revenue)
            const tbPrior = tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)
            assert.equal(tbRevenue?.balance, '-25.0000')
            assert.equal(tbRevenue?.credits, '25.0000')
            assert.ok(tbPrior, 'prior-year RE placeholder appears once prior-year P&L exists')
            assert.equal(tbPrior.credits, '80.0000')
            assert.equal(tbPrior.balance, '-80.0000')
            const tbSum = tb.reduce((sum, row) => decimalAdd(sum, row.balance), '0.0000')
            assert.ok(decimalIsZero(tbSum), `trial balance must foot, got ${tbSum}`)
            const tbDebits = tb.reduce((sum, row) => decimalAdd(sum, row.debits), '0.0000')
            const tbCredits = tb.reduce((sum, row) => decimalAdd(sum, row.credits), '0.0000')
            assert.equal(tbDebits, tbCredits)

            const gl = await withBypassContext(() =>
              generalLedger('2026-07-01', scratch.date, { orgId: scratch.orgId, accountId: scratch.accounts.revenue }),
            )
            const glRevenue = gl.accounts.find((row) => row.id === scratch.accounts.revenue)
            assert.equal(glRevenue?.opening, '0.0000', 'P&L opening is FY start, not lifetime')
            assert.equal(glRevenue?.closing, '-25.0000')
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })

        test('first fiscal year has zero prior earnings and an unwindowed trial balance', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            await withBypass(async () => {
              await post({
                orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
                periodId: scratch.periodId, date: scratch.date,
                debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
                amount: '40.0000', tag: 'YE-FIRST',
              })
            })
            const bs = await withBypassContext(() => balanceSheet(scratch.date, scratch.orgId))
            assert.equal(bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.balance, '0.0000')
            assert.equal(bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)?.balance, '40.0000')

            const tb = await withBypassContext(() => trialBalance(scratch.date, undefined, scratch.orgId))
            assert.equal(tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID), undefined)
            assert.equal(tb.find((row) => row.id === scratch.accounts.revenue)?.balance, '-40.0000')
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })

        test('July fiscal year start splits June activity into prior-year earnings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            await withBypass(async () => {
              await db.execute(sql`
                update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 7}'::jsonb
                 where id = ${scratch.orgId}`)
              const calendarId = await fiscalCalendarId(scratch.orgId, scratch.periodId)
              const juneId = await insertPeriod({
                orgId: scratch.orgId, calendarId, year: 2026, number: 6,
                name: '2026-06', from: '2026-06-01', to: '2026-06-30',
              })
              await post({
                orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
                periodId: juneId, date: '2026-06-15',
                debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
                amount: '15.0000', tag: 'YE-JUNE',
              })
              await post({
                orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
                periodId: scratch.periodId, date: scratch.date,
                debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
                amount: '9.0000', tag: 'YE-JULY',
              })
            })
            const bs = await withBypassContext(() => balanceSheet(scratch.date, scratch.orgId))
            assert.equal(bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.balance, '15.0000')
            assert.equal(bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)?.balance, '9.0000')
            const tb = await withBypassContext(() => trialBalance(scratch.date, undefined, scratch.orgId))
            assert.equal(tb.find((row) => row.id === scratch.accounts.revenue)?.balance, '-9.0000')
            assert.equal(tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.credits, '15.0000')
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })

        test('a 4-4-5 year starting off-month splits boundary P&L on the declared boundary', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          try {
            await withBypass(async () => {
              // Retail calendar: FY2027 starts Saturday 2026-07-05, mid-month.
              // Calendar-month math (FY start 2026-01-01) would put both postings in
              // the current year; the declared boundary puts 07-01 in the prior year.
              const fixtureCalendar = await fiscalCalendarId(scratch.orgId, scratch.periodId)
              await db.execute(sql`
                update fiscal_calendars set is_default = false where id = ${fixtureCalendar}`)
              const calendarId = randomUUID()
              await db.execute(sql`
                insert into fiscal_calendars
                  (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                   adjustment_period_enabled, is_default, is_active, config)
                values (${calendarId}, ${scratch.orgId}, 'Retail 4-4-5', 'four_four_five',
                        7, 6, 'UTC', false, true, true, '{}'::jsonb)`)
              const priorPeriodId = await insertPeriod({
                orgId: scratch.orgId, calendarId, year: 2026, number: 12,
                name: 'FY2026-P12', from: '2026-06-28', to: '2026-07-04',
              })
              const currentPeriodId = await insertPeriod({
                orgId: scratch.orgId, calendarId, year: 2027, number: 1,
                name: 'FY2027-P01', from: '2026-07-05', to: '2026-08-01',
              })
              await post({
                orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
                periodId: priorPeriodId, date: '2026-07-01',
                debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
                amount: '80.0000', tag: 'YE-445-PRIOR',
              })
              await post({
                orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
                periodId: currentPeriodId, date: '2026-07-10',
                debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
                amount: '25.0000', tag: 'YE-445-CURRENT',
              })
            })

            const bs = await withBypassContext(() => balanceSheet('2026-07-15', scratch.orgId))
            assert.equal(bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.balance, '80.0000')
            assert.equal(bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)?.balance, '25.0000')

            const tb = await withBypassContext(() => trialBalance('2026-07-15', undefined, scratch.orgId))
            assert.equal(tb.find((row) => row.id === scratch.accounts.revenue)?.balance, '-25.0000')
            assert.equal(tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.credits, '80.0000')

            const view = await withBypassContext(() => balanceSheetView(
              { from: '2026-07-01', to: '2026-07-15' }, 'July 2026', labels, { orgId: scratch.orgId },
            ))
            assert.equal(findLine(view, 'Retained earnings (prior years)').values?.[0], '80.0000')
            assert.equal(findLine(view, 'Current year earnings').values?.[0], '25.0000')
            assert.deepEqual(findLine(view, 'Retained earnings (prior years)').drillWindows?.[0], {
              from: null, to: '2026-07-04', mode: 'balance',
            })
            assert.deepEqual(findLine(view, 'Current year earnings').drillWindows?.[0], {
              from: '2026-07-05', to: '2026-07-15', mode: 'flow',
            })
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId))
          }
        })
  } },
] as const;

for (const row of payrollReportingCases) await row.register();
