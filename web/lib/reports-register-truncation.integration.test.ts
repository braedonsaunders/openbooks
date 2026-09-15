import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test("truncated ledger and party registers retain complete closing balances", { skip: !env.OPENBOOKS_DB_URL }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withBypass, withOrg } from "./engine/src/db.ts";
    import { createScratchOrg, dropScratchOrg } from "./engine/src/test-fixtures.ts";
    import { generalLedger, partyRegister } from "./web/lib/reports.ts";

    const scratch = await withBypass(() => createScratchOrg());
    const amounts = ["100.0000", "50.0000", "25.0000"];
    try {
      await withBypass(async () => {
        for (const [index, amount] of amounts.entries()) {
          const entryId = randomUUID();
          const date = \`2026-07-\${String(22 - index).padStart(2, "0")}\`;
          await db.execute(sql\`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin, posted_at)
            values
              (\${entryId}, \${scratch.orgId}, \${scratch.bookId}, \${scratch.subsidiaryId},
               \${"TRUNC-" + index}, \${date}, \${scratch.periodId}, \${"Truncated " + index},
               'draft', 'manual', null)
          \`);
          await db.execute(sql\`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
               amount, currency, txn_amount, fx_rate)
            values
              (\${scratch.orgId}, \${entryId}, 1, \${scratch.accounts.bank}, \${scratch.subsidiaryId}, null,
               \${amount}, 'CAD', \${amount}, '1'),
              (\${scratch.orgId}, \${entryId}, 2, \${scratch.accounts.ap}, \${scratch.subsidiaryId}, \${scratch.vendorId},
               \${"-" + amount}, 'CAD', \${"-" + amount}, '1')
          \`);
          await db.execute(sql\`
            update journal_entries set status = 'posted', posted_at = now()
             where id = \${entryId} and org_id = \${scratch.orgId}
          \`);
        }
      });

      await withOrg(scratch.orgId, async () => {
        const ledger = await generalLedger(scratch.date, scratch.date.replace("15", "31"), { maxLines: 1 });
        assert.equal(ledger.truncated, true);
        const bank = ledger.accounts.find((account) => account.id === scratch.accounts.bank);
        assert.ok(bank);
        assert.equal(bank.lines.length, 1);
        assert.equal(bank.lines[0]?.balance, "25.0000");
        assert.equal(bank.closing, "175.0000");

        const register = await partyRegister("ap", {
          from: scratch.date,
          to: scratch.date.replace("15", "31"),
          maxLines: 1,
        });
        assert.equal(register.truncated, true);
        assert.equal(register.parties.length, 1);
        assert.equal(register.parties[0]?.lines.length, 1);
        assert.equal(register.parties[0]?.lines[0]?.balance, "-25.0000");
        assert.equal(register.parties[0]?.closing, "-175.0000");
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
});
