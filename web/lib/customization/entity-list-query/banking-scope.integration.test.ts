import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

// Reconciliation and imported-statement lists show a restricted reader only
// the bank accounts owned by an entity in its scope, the same boundary the
// account workspace enforces. A shared account (no subsidiary) carries every
// entity's cash, so its sessions and statements stay unrestricted-only, and
// another entity's account never appears. SQL builders and storage are real;
// only server-only is stubbed.
const { db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedPostingAccount } =
  await import("@openbooks/engine/testing/fixtures");
const { bankReconciliationWhere, bankStatementWhere } = await import("./banking.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "banking lists keep shared and other-entity bank accounts from a restricted reader",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const other = randomUUID();
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      const own = await seedPostingAccount(
        org.orgId,
        "1091",
        "Own operating bank",
        "asset_bank",
        org.subsidiaryId,
      );
      const foreign = await seedPostingAccount(
        org.orgId,
        "1092",
        "Other entity bank",
        "asset_bank",
        other,
      );
      const shared = await seedPostingAccount(
        org.orgId,
        "1093",
        "Shared operating bank",
        "asset_bank",
        null,
      );
      for (const accountId of [own, foreign, shared]) {
        await db.execute(sql`insert into reconciliations (org_id, account_id, through_date, statement_balance, currency)
        values (${org.orgId}, ${accountId}, ${org.date}, '420', 'CAD')`);
        await db.execute(sql`insert into bank_statements (org_id, account_id, source, statement_date, raw_file_ref)
        values (${org.orgId}, ${accountId}, 'csv', ${org.date}, ${`scope-${accountId}`})`);
      }
      const reconciliationAccounts = async (scope: Set<string> | null) =>
        (
          await db.execute<{ account_id: string }>(
            sql`
      select r.account_id from reconciliations r
        join accounts bank_account on bank_account.id = r.account_id and bank_account.org_id = r.org_id
       where ${bankReconciliationWhere({ ...defaultListView("bank_reconciliation"), filters: [] }, {}, org.orgId, scope)}`,
            "objects",
          )
        )
          .map((row) => row.account_id)
          .sort();
      const statementAccounts = async (scope: Set<string> | null) =>
        (
          await db.execute<{ account_id: string }>(
            sql`
      select bs.account_id from bank_statements bs
        join accounts statement_account on statement_account.id = bs.account_id and statement_account.org_id = bs.org_id
       where ${bankStatementWhere({ ...defaultListView("bank_statement"), filters: [] }, {}, org.orgId, scope)}`,
            "objects",
          )
        )
          .map((row) => row.account_id)
          .sort();

      const restricted = new Set([org.subsidiaryId]);
      assert.deepEqual(await reconciliationAccounts(restricted), [own]);
      assert.deepEqual(await statementAccounts(restricted), [own]);
      assert.deepEqual(await reconciliationAccounts(new Set()), [], "an empty scope sees nothing");
      assert.deepEqual(
        await reconciliationAccounts(null),
        [own, foreign, shared].sort(),
        "unrestricted readers see every account",
      );
      assert.deepEqual(await statementAccounts(null), [own, foreign, shared].sort());
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
