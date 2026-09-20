import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { env } from "@openbooks/engine/src/platform/db.ts";

test("registers scope every journal read to one accounting book", () => {
  const source = readFileSync(new URL("./reports/registers.ts", import.meta.url), "utf8");
  assert.match(source, /statementBookExpr/);
  // accountRegister: trailing bookId with a primary-book default, applied to
  // both the page query and the count query.
  assert.match(source, /bookId\?: string \| null,\n\) \{/);
  // partyRegister: explicit opt threaded into the opening and lines queries.
  assert.match(source, /maxLines\?: number; bookId\?: string \| null \}/);
  // partnerStatement: forwards its caller's book into partyRegister.
  assert.match(source, /bookId: opts\.bookId \}/);
  const direct = source.match(/e\.book_id = \$\{statementBookExpr\(/g) ?? [];
  const shared = source.match(/\$\{bookFilter\}/g) ?? [];
  assert.ok(
    direct.length + shared.length >= 4,
    `registers carry a book predicate on every journal read (direct ${direct.length}, shared ${shared.length})`,
  );
});

test("resolveReport honors an explicit book for book-capable detail reports", () => {
  const source = readFileSync(new URL("./report-run.ts", import.meta.url), "utf8");
  assert.match(source, /detailBookId/);
  for (const needle of [
    "bookId: detailBookId",
    "trialBalance(asOf, dims, orgId, detailBookId)",
    "partnerBalances(s, orgId, asOf, detailBookId, dims)",
    "cashFlow(from, to, dims, orgId, detailBookId)",
    "cashFlowIndirect(from, to, dims, orgId, detailBookId)",
  ]) {
    assert.ok(source.includes(needle), `resolveReport threads the book into ${needle}`);
  }
});

test(
  "registers answer for the primary book when a parallel book posts the same activity",
  { skip: !env.OPENBOOKS_DB_URL },
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
