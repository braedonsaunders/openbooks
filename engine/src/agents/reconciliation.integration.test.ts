import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { reconciliationFindings } from "./reconciliation.ts";

/**
 * Live-PostgreSQL proof for the reconciliation pack with its production
 * loaders: autoMatch-mirror candidates with exact proposals, stale sessions
 * (balanced ones propose sign-off), never-reconciled accounts, and org
 * isolation.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type OrgShape = { orgId: string; bookId: string; subsidiaryId: string; periodId: string; date: string; accounts: Record<string, string> };

async function seedBankReceipt(org: OrgShape, bankAccount: string, revenueAccount: string, amount: string, postingDate: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${id}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${id}, ${postingDate}, ${org.periodId}, 'draft', 'manual')`);
      await tx.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${id}, 1, ${bankAccount}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1),
               (${org.orgId}, ${id}, 2, ${revenueAccount}, ${org.subsidiaryId}, -${amount}::numeric, 'CAD', -${amount}::numeric, 1)`);
      await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${id}`);
    }),
  );
  return id;
}

async function seedStatement(orgId: string, accountId: string, statementDate: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into bank_statements (id, org_id, account_id, source, statement_date, opening_balance, closing_balance, raw_file_ref)
    values (${id}, ${orgId}, ${accountId}, 'test', ${statementDate}, '0', '0', 'test-seed')`));
  return id;
}

async function seedLine(statementId: string, orgId: string, accountId: string, postedOn: string, amount: string, description: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into bank_statement_lines (id, org_id, statement_id, account_id, line_number, posted_on, amount, currency, description)
    values (${id}, ${orgId}, ${statementId}, ${accountId}, 1, ${postedOn}, ${amount}, 'CAD', ${description})`));
  return id;
}

async function seedReconcilableAccount(orgId: string, number: string, name: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into accounts (id, org_id, number, name, type, reconcilable, currency_restriction)
    values (${id}, ${orgId}, ${number}, ${name}, 'asset_bank', true, 'CAD')`));
  return id;
}

test(
  "reconciliation pack proposes matches, sign-offs, and first sessions",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const other = await withBypass(() => createScratchOrg());
    try {
      const today = await withBypassContext(() => businessToday(org.orgId));
      const bank = org.accounts.bank;

      // Candidate pair: $2500 line two days old, journal posted yesterday.
      const statement = await seedStatement(org.orgId, bank, today);
      const lineId = await seedLine(statement, org.orgId, bank, shiftDays(today, -2), "2500.00", "Counterparty transfer");
      await seedLine(statement, org.orgId, bank, shiftDays(today, -10), "200.00", "Small debit");
      await seedBankReceipt(org, bank, org.accounts.revenue, "2500.00", shiftDays(today, -1));
      const session = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into reconciliations (id, org_id, account_id, through_date, statement_balance, status, currency)
        values (${session}, ${org.orgId}, ${bank}, ${today}, '2500.00', 'in_progress', 'CAD')`));

      // Stale balanced session on a second account: sign-off proposal.
      const staleAccount = await seedReconcilableAccount(org.orgId, "1020", "Reserve");
      const staleSession = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into reconciliations (id, org_id, account_id, through_date, statement_balance, status, currency)
        values (${staleSession}, ${org.orgId}, ${staleAccount}, ${shiftDays(today, -30)}, '0', 'in_progress', 'CAD')`));
      await withBypassContext(() => db.execute(sql`
        update reconciliations set updated_at = ${`${shiftDays(today, -10)}T00:00:00Z`}::timestamptz
         where id = ${staleSession}`));

      // Never reconciled: activity with no session row at all.
      const freshAccount = await seedReconcilableAccount(org.orgId, "1030", "Payroll");
      const freshStatement = await seedStatement(org.orgId, freshAccount, today);
      await seedLine(freshStatement, org.orgId, freshAccount, shiftDays(today, -20), "4500.00", "Payroll funding");
      // Below the floor: stays silent.
      const quietAccount = await seedReconcilableAccount(org.orgId, "1040", "Petty");
      const quietStatement = await seedStatement(org.orgId, quietAccount, today);
      await seedLine(quietStatement, org.orgId, quietAccount, shiftDays(today, -5), "800.00", "Petty top-up");

      // Another tenant's unmatched line: must not leak in.
      const foreignStatement = await seedStatement(other.orgId, other.accounts.bank, today);
      await seedLine(foreignStatement, other.orgId, other.accounts.bank, shiftDays(today, -2), "99999.00", "Foreign line");

      const findings = await withBypassContext(() =>
        reconciliationFindings(org.orgId, "1000.0000", defaultContinuousCloseDetectors("reconciliation")),
      );
      const byType = (type: string) => findings.filter((finding) => finding.findingType === type);

      const candidates = byType("bank_line_match_candidate");
      assert.equal(candidates.length, 1, "only the bank account has a qualifying pair");
      assert.equal(candidates[0]!.materiality, "2500.0000", "the $200 line has no journal peer");
      assert.equal(candidates[0]!.proposal?.tool, "match_bank_line");
      const matchInput = candidates[0]!.proposal?.input as { reconciliationId: string; statementLineId: string; journalLineIds: string[] };
      assert.equal(matchInput.reconciliationId, session, "the proposal names the open session");
      assert.equal(matchInput.statementLineId, lineId);
      assert.equal(matchInput.journalLineIds.length, 1, "exactly one journal leg, like autoMatch");

      const stale = byType("stale_reconciliation");
      assert.equal(stale.length, 1, "the fresh bank session was touched today");
      assert.equal(stale[0]!.materiality, "0.0000");
      assert.deepEqual(stale[0]!.proposal, {
        tool: "sign_off_reconciliation",
        input: { reconciliationId: staleSession },
        label: `Sign off Reserve through ${shiftDays(today, -30)}`,
      });

      const never = byType("never_reconciled_account");
      assert.equal(never.length, 1, "quiet account below floor; bank + reserve have session rows");
      assert.equal(never[0]!.materiality, "4500.0000");
      assert.equal(never[0]!.proposal ?? null, null);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);
