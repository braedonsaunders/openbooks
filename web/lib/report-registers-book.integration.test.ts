import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Database partition: the register book-scoping contract needs PostgreSQL
// (scratch org, parallel tax book, posted lines), so it lives under the
// .integration suffix with no skip guard.

test(
  "registers answer for the primary book when a parallel book posts the same activity",
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db, withBypass, withBypassContext, withOrgContext } from "./engine/src/platform/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

      installTrustedTestDatabaseBypass();
      // Seeds run under the explicit bypass: importing the registers reader
      // below replaces the process-wide test bypass, so unscoped seeds and
      // reads would silently see zero rows after that import.
      const scratch = await withBypassContext(() => createScratchOrg());
      const taxBookId = randomUUID();
      try {
        await withBypassContext(() => db.execute(sql\`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`));

        const postAR = async (bookId, tag) => {
          const entryId = randomUUID();
          await withBypassContext(async () => {
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${'REGBOOK-' + tag}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual')\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               party_id, amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.ar},
               \${scratch.subsidiaryId}, \${scratch.customerId}, '500.0000', 'CAD', '500.0000', '1'),
              (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, \${scratch.customerId}, '-500.0000', 'CAD', '-500.0000', '1')\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${entryId}\`);
          });
        };
        await postAR(scratch.bookId, 'PRI');
        await postAR(taxBookId, 'TAX');

        const { partyRegister, accountRegister, partnerStatement } =
          await import("./web/lib/reports/registers.ts");

        // Reads run under the org scope, proving the primary-book default
        // holds under enforcement rather than under the seed bypass.
        await withOrgContext(scratch.orgId, async () => {
        // Default scope is the primary book only — never the merged pair.
        const reg = await partyRegister('ar', { from: scratch.date, to: scratch.date, orgId: scratch.orgId });
        assert.equal(reg.parties.length, 1);
        assert.equal(String(reg.parties[0].closing), '500.0000');
        assert.equal(reg.parties[0].lines.length, 1);

        const acct = await accountRegister(scratch.orgId, scratch.accounts.ar, 100, 0,
          { from: scratch.date, to: scratch.date }, null);
        assert.equal(acct.balance, '500.0000');
        assert.equal(acct.lines.length, 1);
        assert.equal(acct.total, 1);

        const stmt = await partnerStatement(scratch.customerId, scratch.orgId,
          { from: scratch.date, to: scratch.date, side: 'ar' });
        assert.equal(String(stmt.closing), '500.0000');
        assert.equal(stmt.lines.length, 1);

        // An explicit book reads that book — the tax mirror is intact.
        const taxReg = await partyRegister('ar',
          { from: scratch.date, to: scratch.date, orgId: scratch.orgId, bookId: taxBookId });
        assert.equal(taxReg.parties.length, 1);
        assert.equal(String(taxReg.parties[0].closing), '500.0000');
        const taxAcct = await accountRegister(scratch.orgId, scratch.accounts.ar, 100, 0,
          { from: scratch.date, to: scratch.date }, null, taxBookId);
        assert.equal(taxAcct.balance, '500.0000');
        console.log('registers stay primary-scoped with a parallel book present');
        });
      } finally {
        await withBypass(() => dropScratchOrg(scratch.orgId));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
);


const consolidatedRows = [
  { label: "report currency basis", register: async () => {
        const { randomUUID }=await import("node:crypto");
        const { sql } = await import('drizzle-orm')
        const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { generalLedger, journalReport } = await import('./reports/ledger-reports')
        const { accountRegister, partyRegister, partnerStatement } = await import('./reports/registers')
        const { trialBalance, profitAndLoss, balanceSheet, partnerBalances } = await import('./reports/statements')
        const { cashFlow } = await import('./reports/cash-flow')
        const { cashFlowIndirect } = await import('./reports/cash-flow-indirect')
        const { projectProfitability } = await import('./reports/projects')
        
        test('raw report readers refuse mixed functional currencies and preserve native single-currency scopes', { skip: !env.OPENBOOKS_DB_URL }, async () => {
          const scratch = await withBypass(() => createScratchOrg())
          const child = randomUUID()
          try {
            await withBypass(async () => {
              await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
                values (${child}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'USD entity', 'USD', 'US')`)
              for (const [subsidiary, currency, code] of [[scratch.subsidiaryId, 'CAD', 'CAD'], [child, 'USD', 'USD']]) {
                const entry = randomUUID(), project = randomUUID()
                await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
                  values (${project}, ${scratch.orgId}, ${subsidiary}, ${code}, ${code}, ${scratch.customerId}, 'active', true)`)
                await db.execute(sql`insert into journal_entries
                  (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
                  values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${subsidiary}, ${code}, ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')`)
                await db.execute(sql`insert into journal_lines
                  (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, party_id, amount, currency, txn_amount, fx_rate)
                  values (${scratch.orgId}, ${entry}, 1, ${scratch.accounts.bank}, ${subsidiary}, ${project}, ${scratch.customerId}, '100', ${currency}, '100', '1'),
                    (${scratch.orgId}, ${entry}, 2, ${scratch.accounts.ar}, ${subsidiary}, ${project}, ${scratch.customerId}, '100', ${currency}, '100', '1'),
                    (${scratch.orgId}, ${entry}, 3, ${scratch.accounts.revenue}, ${subsidiary}, ${project}, ${scratch.customerId}, '-200', ${currency}, '-200', '1')`)
                await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
              }
            })
            const org = scratch.orgId, day = scratch.date, book = scratch.bookId
            const readers: Record<string, (subsidiaryIds: string[]) => Promise<unknown>> = {
              ledger: (subsidiaryIds) => generalLedger(day, day, { orgId: org, bookId: book, dims: { subsidiaryIds } }),
              journal: (subsidiaryIds) => journalReport(day, day, { orgId: org, bookId: book, dims: { subsidiaryIds } }),
              register: (ids) => accountRegister(org, scratch.accounts.ar, 100, 0, undefined, new Set(ids), book),
              parties: (subsidiaryIds) => partyRegister('ar', { orgId: org, bookId: book, from: day, to: day, dims: { subsidiaryIds } }),
              statement: (subsidiaryIds) => partnerStatement(scratch.customerId, org, { from: day, to: day, side: 'ar', bookId: book, dims: { subsidiaryIds } }),
              trial: (subsidiaryIds) => trialBalance(day, { subsidiaryIds }, org, book),
              pnl: (subsidiaryIds) => profitAndLoss(day, day, { subsidiaryIds }, org, book),
              balance: (subsidiaryIds) => balanceSheet(day, org, book, { subsidiaryIds }),
              partners: (subsidiaryIds) => partnerBalances('receivable', org, day, book, { subsidiaryIds }),
              cash: (subsidiaryIds) => cashFlow(day, day, { subsidiaryIds }, org, book),
              indirect: (subsidiaryIds) => cashFlowIndirect(day, day, { subsidiaryIds }, org, book),
              projects: (subsidiaryIds) => projectProfitability(day, day, { orgId: org, bookId: book, dims: { subsidiaryIds } }),
            }
            // Reads run in the scratch org's scope: the report readers issue bare
            // queries with explicit org predicates, which pooled RLS denies outside an
            // explicit scope. Unscoped, every reader sees zero rows — so the
            // mixed-currency rejection below goes missing (deny-all hides the rows
            // that should trigger it) and the closing/balance asserts read undefined.
            await withOrgContext(scratch.orgId, async () => {
              for (const [name, read] of Object.entries(readers)) {
                await assert.rejects(() => read([scratch.subsidiaryId, child]), { name: 'ReportCurrencyBasisError' }, name)
                await read([scratch.subsidiaryId])
                await read([child])
                await read([])
              }
              const cad = await generalLedger(day, day, { orgId: org, dims: { subsidiaryIds: [scratch.subsidiaryId] } })
              assert.equal(cad.accounts.find((account) => account.id === scratch.accounts.revenue)?.closing, '-200.0000')
              const usd = await trialBalance(day, { subsidiaryIds: [child] }, org)
              assert.equal(usd.find((account) => account.id === scratch.accounts.ar)?.balance, '100.0000')
              // An unused second currency cannot block an earlier empty report.
              await generalLedger('2000-01-01', '2000-01-02', { orgId: org })
              // The raw-line (non-summary) branch observes the same dimension scope.
              await profitAndLoss(day, day, { subsidiaryIds: [scratch.subsidiaryId, child], departmentId: randomUUID() }, org)
              await trialBalance(day, { subsidiaryIds: [scratch.subsidiaryId, child], departmentId: randomUUID() }, org)
            })
          } finally { await withBypass(() => dropScratchOrg(scratch.orgId)) }
        })
  } },
] as const;

for(const row of consolidatedRows) await row.register();
