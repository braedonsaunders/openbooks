import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test(
  "all balance readers stay on the primary accounting book",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db, withBypass, withOrg } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";

      installTrustedTestDatabaseBypass();
      const scratch = await createScratchOrg();
      try {
        const taxBookId = randomUUID();
        await db.execute(sql\`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`);

        // A July fiscal year makes the June summary row prior-year P&L. The
        // accounts list and COA balance must exclude it while ledger opening
        // still includes it as inception-to-date activity.
        await db.execute(sql\`
          update orgs
             set settings = jsonb_set(settings, '{fiscalYearStartMonth}', '7'::jsonb, true)
           where id = \${scratch.orgId}\`);
        await db.execute(sql\`
          insert into gl_month_activity
            (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
          values
            (\${scratch.orgId}, \${scratch.accounts.revenue}, \${scratch.bookId}, '2026-06-01',
             \${scratch.subsidiaryId}, '0.0000', '25.0000', 1)\`);

        const postEntry = async (bookId, tag) => {
          const entryId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${'BALANCE-' + tag}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual')\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank},
               \${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', '1'),
              (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', '1')\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${entryId}\`);
        };

        const categoryId = randomUUID();
        await db.execute(sql\`
          insert into asset_categories
            (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
             depreciation_expense_account_id)
          values
            (\${categoryId}, \${scratch.orgId}, 'Equipment', \${scratch.accounts.invAsset},
             \${scratch.accounts.invAsset}, \${scratch.accounts.adjustment})\`);
        const assetId = randomUUID();
        await db.execute(sql\`
          insert into fixed_assets
            (id, org_id, category_id, asset_number, name, acquisition_cost,
             subsidiary_id, status, acquired_on)
          values
            (\${assetId}, \${scratch.orgId}, \${categoryId}, 'FA-001', 'Equipment',
             '100.0000', \${scratch.subsidiaryId}, 'in_service', \${scratch.date})\`);

        const seedDepreciation = async (bookId, tag) => {
          const scheduleId = randomUUID();
          await db.execute(sql\`
            insert into depreciation_schedules
              (id, org_id, asset_id, book_id, method, life_months)
            values
              (\${scheduleId}, \${scratch.orgId}, \${assetId}, \${bookId}, 'straight_line', 12)\`);
          await db.execute(sql\`
            insert into depreciation_schedule_lines
              (id, org_id, schedule_id, period_id, sequence, planned_amount,
               posted_amount, source)
            values
              (\${randomUUID()}, \${scratch.orgId}, \${scheduleId}, \${scratch.periodId},
               1, '10.0000', '10.0000', 'imported')\`);
          return tag;
        };

        await postEntry(scratch.bookId, 'PRIMARY');
        await seedDepreciation(scratch.bookId, 'PRIMARY');

        await withOrg(scratch.orgId, async () => {
          const { generalLedger, journalReport } = await import("./web/lib/reports/ledger-reports.ts");
          const { accountsWithBalances } = await import("./web/lib/data.ts");
          const { accountBaseJoins } = await import("./web/lib/customization/entity-list-query/accounts.ts");
          const { FIXED_ASSET_BASE_JOINS } = await import("./web/lib/customization/entity-list-query/fixed-assets.ts");

          const readAll = async () => {
            const ledger = await generalLedger(scratch.date, scratch.date, {
              orgId: scratch.orgId,
              accountId: scratch.accounts.revenue,
            });
            const journal = await journalReport(scratch.date, scratch.date, { orgId: scratch.orgId });
            const balances = await accountsWithBalances(scratch.orgId, scratch.date);
            const accountList = await db.execute(sql\`
              select a.id, account_balance.amount
                from accounts a
                \${accountBaseJoins(scratch.date)}
               where a.org_id = \${scratch.orgId} and a.id = \${scratch.accounts.revenue}\`);
            const assets = await db.execute(sql\`
              select a.id, a.acquisition_cost - depr.accumulated as net_book_value
                from fixed_assets a
                \${FIXED_ASSET_BASE_JOINS}
               where a.org_id = \${scratch.orgId} and a.id = \${assetId}\`);
            return {
              ledger: ledger.accounts.map((account) => ({
                id: account.id,
                opening: String(account.opening),
                closing: String(account.closing),
                lines: account.lines.length,
              })),
              journal: journal.entries.map((entry) => ({
                id: entry.id,
                lines: entry.lines.length,
                totalDebit: String(entry.totalDebit),
              })),
              revenueBalance: String(balances.find((row) => row.id === scratch.accounts.revenue)?.balance),
              accountListBalance: String(accountList.rows[0]?.amount),
              netBookValue: String(assets.rows[0]?.net_book_value),
            };
          };

          const before = await readAll();
          assert.equal(before.ledger.length, 1);
          assert.equal(before.ledger[0].lines, 1);
          assert.equal(before.ledger[0].opening, '-25.0000');
          assert.equal(before.ledger[0].closing, '-125.0000');
          assert.equal(before.journal.length, 1);
          assert.equal(before.journal[0].lines, 2);
          assert.equal(before.revenueBalance, '100.0000');
          assert.equal(before.accountListBalance, '100.0000');
          assert.equal(before.netBookValue, '90.0000');

          await postEntry(taxBookId, 'TAX');
          await seedDepreciation(taxBookId, 'TAX');
          const after = await readAll();
          assert.deepEqual(after, before, 'adding a tax book must not alter any primary-book reader');
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
