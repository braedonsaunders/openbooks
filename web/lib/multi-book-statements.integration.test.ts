import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test(
  "statements answer per accounting book across summary, raw, and trial-balance paths",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { readFileSync } from "node:fs";
      import { sql } from "drizzle-orm";
      import { db, pool, withBypass, withOrg } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import {
        createScratchOrg,
        dropScratchOrg,
      } from "./engine/src/test-fixtures.ts";

      // Web modules install the normal request resolver during evaluation.
      // Re-establish the explicit test-only trusted boundary afterwards.
      installTrustedTestDatabaseBypass();
      const scratch = await createScratchOrg();
      try {
        // A second, parallel book. journal_entries.book_id is mandatory, so
        // identical activity in both books must never fuse into one total.
        const taxBookId = randomUUID();
        await db.execute(sql\`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (\${taxBookId}, \${scratch.orgId}, 'TAX', 'Tax book', false, true, true)\`);

        const departmentId = randomUUID();
        await db.execute(sql\`
          insert into departments (id, org_id, name)
          values (\${departmentId}, \${scratch.orgId}, 'Ops')\`);

        // Post the SAME -100 revenue to each book CONCURRENTLY. Pre-0016 this
        // raced into one gl_month_activity row crediting 200 for the pair.
        const postRevenue = async (bookId, tag) => {
          const entryId = randomUUID();
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (\${entryId}, \${scratch.orgId}, \${bookId}, \${scratch.subsidiaryId},
               \${'MULTIBOOK-' + tag}, \${scratch.date}, \${scratch.periodId},
               \${tag}, 'draft', 'manual')\`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               department_id, amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank},
               \${scratch.subsidiaryId}, \${departmentId}, '100.0000', 'CAD', '100.0000', '1'),
              (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.revenue},
               \${scratch.subsidiaryId}, \${departmentId}, '-100.0000', 'CAD', '-100.0000', '1')\`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${entryId}\`);
          return entryId;
        };
        const [primaryEntryId] = await Promise.all([
          postRevenue(scratch.bookId, 'PRI'),
          postRevenue(taxBookId, 'TAX'),
        ]);
        assert.ok(primaryEntryId);

        // The derived key carries book_id and the trigger maintenance kept the
        // books apart under concurrent posting: two rows, -100 revenue credit
        // each — not one fused row of -200.
        const summaryRows = await db.execute(sql\`
          select g.book_id, g.debit_total, g.credit_total, g.line_count
            from gl_month_activity g
           where g.org_id = \${scratch.orgId}
             and g.account_id = \${scratch.accounts.revenue}\`);
        const byBook = new Map(summaryRows.rows.map((r) => [r.book_id, r]));
        assert.equal(summaryRows.rows.length, 2, "summary keeps one row per book: " + JSON.stringify(summaryRows.rows));
        for (const bookId of [scratch.bookId, taxBookId]) {
          const row = byBook.get(bookId);
          assert.ok(row, "row exists for each book");
          assert.equal(row.credit_total, "100.0000");
          assert.equal(row.debit_total, "0.0000");
          assert.equal(row.line_count, "1");
        }

        // The trigger-maintained summary agrees with the ledger per book
        // (verify returns only mismatching rows).
        const mismatches = await db.execute(sql\`
          select * from openbooks_gl_activity_verify(\${scratch.orgId})\`);
        assert.deepEqual(mismatches.rows, []);

        await withOrg(scratch.orgId, async () => {
          const { statementMatrix, PNL_TYPES } = await import("./web/lib/statement-matrix.ts");
          const { trialBalance } = await import("./web/lib/reports/statements.ts");
          const period = { from: scratch.date, to: scratch.date };
          const readerRevenue = (matrix) => {
            const row = matrix.rows.find((r) => r.id === scratch.accounts.revenue);
            return row ? String(row.values[0]) : null;
          };

          // Summarized path (whole months from gl_month_activity): -100 of
          // revenue reads as +100 for EACH selected book; omitting the book
          // answers for the primary book only — never the merged pair.
          for (const [bookId, expected] of [[scratch.bookId, "100.0000"], [taxBookId, "100.0000"]]) {
            const matrix = await statementMatrix({
              types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook",
              bookId,
            });
            assert.equal(readerRevenue(matrix), expected, "summarized path book-scoped");
          }
          const defaultMatrix = await statementMatrix({
            types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook" });
          assert.equal(readerRevenue(defaultMatrix), "100.0000", "default report scope is the primary book");

          // Raw path (a line-level dimension filter disables the summary): a
          // department slice matches both books' lines, yet each book still
          // reports exactly its own -100 — no double counting.
          for (const bookId of [scratch.bookId, taxBookId]) {
            const raw = await statementMatrix({
              types: PNL_TYPES, mode: "flow", period, periodLabel: "multibook",
              dims: { departmentId }, bookId,
            });
            assert.equal(raw.truncated, false);
            assert.equal(readerRevenue(raw), "100.0000", "raw path book-scoped");
          }

          // Split-month windows ride the union leg (lines) for the boundary
          // month; the book filter must hold there too.
          const splitFrom = scratch.date.slice(0, 8) + "10";
          const splitTo = scratch.date.slice(0, 8) + "20";
          for (const bookId of [scratch.bookId, taxBookId]) {
            const split = await statementMatrix({
              types: PNL_TYPES, mode: "flow",
              period: { from: splitFrom, to: splitTo }, periodLabel: "multibook",
              bookId,
            });
            assert.equal(readerRevenue(split), "100.0000", "split-month union leg book-scoped");
          }

          // Trial balance: per book the revenue credit shows as 100 credits /
          // -100 balance; the default scope stays primary-only.
          for (const [bookId, label] of [[scratch.bookId, "primary"], [taxBookId, "tax"]]) {
            const tb = await trialBalance(scratch.date, undefined, scratch.orgId, bookId);
            const revenue = tb.find((r) => r.id === scratch.accounts.revenue);
            const bank = tb.find((r) => r.id === scratch.accounts.bank);
            assert.ok(revenue, label + " book trial balance has revenue");
            assert.equal(revenue.credits, "100.0000");
            assert.equal(revenue.balance, "-100.0000");
            assert.ok(bank, label + " book trial balance has bank");
            assert.equal(bank.debits, "100.0000");
          }
          const defaultTb = await trialBalance(scratch.date, undefined, scratch.orgId);
          assert.equal(defaultTb.find((r) => r.id === scratch.accounts.revenue)?.credits, "100.0000");
        });

        // Migration atomicity: replaying 0016 inside a transaction that then
        // FAILS must leave the prior summary exactly as it was — same shape,
        // same rows, working trigger maintenance — after rollback recovers it.
        const migration = readFileSync(
          "schema/migrations/generated/0016_gl_month_activity_book_id.sql", "utf8");
        const before = await db.execute(sql\`
          select book_id, account_id, month, subsidiary_id, debit_total, credit_total, line_count
            from gl_month_activity where org_id = \${scratch.orgId} order by account_id, book_id\`);
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(migration);
          // Force a failure against the NEW constraint mid-flight.
          await client.query(
            "insert into gl_month_activity (org_id, account_id, book_id, month, subsidiary_id) " +
            "select org_id, account_id, book_id, month, subsidiary_id from gl_month_activity limit 1");
          assert.fail("forced duplicate-key failure did not raise");
        } catch (error) {
          await client.query("rollback");
          assert.match(String((error && error.message) || error), /duplicate key|unique constraint/);
        } finally {
          client.release();
        }
        const after = await db.execute(sql\`
          select book_id, account_id, month, subsidiary_id, debit_total, credit_total, line_count
            from gl_month_activity where org_id = \${scratch.orgId} order by account_id, book_id\`);
        assert.deepEqual(after.rows, before.rows, "failed migration preserved the prior summary rows");

        // And the recovered summary still maintains itself: another posting
        // lands on its own per-book row via the triggers.
        const extraEntry = randomUUID();
        await db.execute(sql\`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin)
          values
            (\${extraEntry}, \${scratch.orgId}, \${taxBookId}, \${scratch.subsidiaryId},
             'MULTIBOOK-AFTER', \${scratch.date}, \${scratch.periodId}, 'after',
             'draft', 'manual')\`);
        await db.execute(sql\`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate)
          values
            (\${scratch.orgId}, \${extraEntry}, 1, \${scratch.accounts.bank},
             \${scratch.subsidiaryId}, '50.0000', 'CAD', '50.0000', '1'),
            (\${scratch.orgId}, \${extraEntry}, 2, \${scratch.accounts.revenue},
             \${scratch.subsidiaryId}, '-50.0000', 'CAD', '-50.0000', '1')\`);
        await db.execute(sql\`
          update journal_entries set status = 'posted', posted_at = now()
           where id = \${extraEntry}\`);
        const postRollback = await db.execute(sql\`
          select g.credit_total from gl_month_activity g
           where g.org_id = \${scratch.orgId}
             and g.account_id = \${scratch.accounts.revenue}
             and g.book_id = \${taxBookId}\`);
        assert.deepEqual(postRollback.rows.map((r) => r.credit_total).sort(), ["150.0000"]);
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
