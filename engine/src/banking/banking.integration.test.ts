import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  adjustReconciliation,
  autoMatch,
  BankingError,
  createMatch,
  discardReconciliation,
  excludeStatementLine,
  importStatement,
  markReconciled,
  reconciliationTotals,
  restoreStatementLine,
  startReconciliation,
  unmatchStatementLine,
} from "./banking.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`BANK-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`Bank reconciliation ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const bankLineIds: string[] = [];
    let lineNumber = 0;
    for (const amount of bankAmounts) {
      const offsetAmount = fromUnits(-toUnits(amount));
      lineNumber += 1;
      const bankLineId = randomUUID();
      bankLineIds.push(bankLineId);
      await tx.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${bankLineId}, ${org.orgId}, ${entryId}, ${lineNumber},
           ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD',
           ${amount}, 1, ${label})
      `);
      lineNumber += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${org.orgId}, ${entryId}, ${lineNumber}, ${org.accounts.adjustment},
           ${org.subsidiaryId}, ${offsetAmount}, 'CAD',
           ${offsetAmount}, 1, ${label})
      `);
    }
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return bankLineIds;
  });
}

test(
  "bank reconciliation is exact, race-safe, tenant-scoped, auditable, and immutable after sign-off",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const otherOrg = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const otherActor = (await seedFlowActors(otherOrg.orgId)).adminId;
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${otherOrg.accounts.bank} and org_id = ${otherOrg.orgId}
      `);

      const hundred = await postBankJournal(org, actor, ["100.0000"], "deposit");
      const splitWithdrawal = await postBankJournal(
        org,
        actor,
        ["-5.0000", "-15.0000"],
        "split-withdrawal",
      );
      const otherTenantLine = await postBankJournal(
        otherOrg,
        otherActor,
        ["100.0000"],
        "other-tenant",
      );

      const statementInput = {
        accountId: org.accounts.bank,
        source: "ofx" as const,
        statementDate: org.date,
        openingBalance: "0",
        closingBalance: "80",
        currency: "CAD",
        lines: [
          {
            postedOn: org.date,
            amount: "100",
            description: "Customer deposit",
            bankTransactionId: "bank-deposit-100",
          },
          {
            postedOn: org.date,
            amount: "-20",
            description: "Split withdrawal",
            bankTransactionId: "bank-withdrawal-20",
          },
          {
            postedOn: org.date,
            amount: "5",
            description: "Documented duplicate",
            bankTransactionId: "bank-excluded-5",
          },
        ],
      };
      const imports = await Promise.all([
        importStatement(statementInput, { orgId: org.orgId, userId: actor }),
        importStatement(statementInput, { orgId: org.orgId, userId: actor }),
      ]);
      assert.equal(imports.filter((result) => result.statementId !== null).length, 1);
      assert.equal(imports.reduce((count, result) => count + result.imported, 0), 3);
      assert.equal(imports.reduce((count, result) => count + result.duplicates, 0), 3);

      const statementRows = (await db.execute<{ id: string; bank_transaction_id: string }>(sql`
        select id, bank_transaction_id
          from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
         order by bank_transaction_id
      `));
      assert.equal(statementRows.rows.length, 3);
      const statementByRef = new Map(
        statementRows.rows.map((row) => [row.bank_transaction_id, row.id]),
      );

      const starts = await Promise.allSettled([
        startReconciliation(
          {
            accountId: org.accounts.bank,
            throughDate: org.date,
            statementBalance: "80",
          },
          { orgId: org.orgId, userId: actor },
        ),
        startReconciliation(
          {
            accountId: org.accounts.bank,
            throughDate: org.date,
            statementBalance: "80",
          },
          { orgId: org.orgId, userId: actor },
        ),
      ]);
      const fulfilled = starts.filter(
        (result): result is PromiseFulfilledResult<{ id: string }> =>
          result.status === "fulfilled",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(
        starts.filter((result) => result.status === "rejected").length,
        1,
      );
      const reconciliationId = fulfilled[0]!.value.id;
      const ctx = { orgId: org.orgId, userId: actor };

      const automatic = await autoMatch(reconciliationId, ctx);
      assert.equal(automatic.matched, 1);
      assert.equal(automatic.highConfidence, 1);

      const withdrawalId = statementByRef.get("bank-withdrawal-20")!;
      await assert.rejects(
        createMatch(
          {
            reconciliationId,
            statementLineId: withdrawalId,
            journalLineIds: [splitWithdrawal[0]!],
          },
          ctx,
        ),
        /total -5\.0000; the statement line is -20\.0000/,
      );
      await assert.rejects(
        createMatch(
          {
            reconciliationId,
            statementLineId: withdrawalId,
            journalLineIds: otherTenantLine,
          },
          ctx,
        ),
        /unavailable/,
      );
      await createMatch(
        {
          reconciliationId,
          statementLineId: withdrawalId,
          journalLineIds: splitWithdrawal,
        },
        ctx,
      );

      await assert.rejects(
        markReconciled(reconciliationId, ctx),
        /remain unmatched/,
      );
      const excludedId = statementByRef.get("bank-excluded-5")!;
      await assert.rejects(
        excludeStatementLine(excludedId, "bad", ctx),
        (error: unknown) =>
          error instanceof BankingError && /between 5 and 500/.test(error.message),
      );
      await excludeStatementLine(
        excludedId,
        "Duplicate confirmed by the bank statement issuer",
        ctx,
      );
      await restoreStatementLine(excludedId, ctx);
      await excludeStatementLine(
        excludedId,
        "Duplicate confirmed by the bank statement issuer",
        ctx,
      );

      const totals = await reconciliationTotals(reconciliationId, ctx);
      assert.deepEqual(totals, {
        statementBalance: "80.0000",
        clearedBalance: "80.0000",
        difference: "0.0000",
        matchedStatementLines: 2,
        unmatchedStatementLines: 0,
        matchedJournalLines: 3,
      });
      const signoffs = await Promise.all([
        markReconciled(reconciliationId, ctx),
        markReconciled(reconciliationId, ctx),
      ]);
      assert.deepEqual(signoffs, [
        { journalLinesReconciled: 3 },
        { journalLinesReconciled: 3 },
      ]);

      await assert.rejects(
        unmatchStatementLine(
          {
            reconciliationId,
            statementLineId: statementByRef.get("bank-deposit-100")!,
          },
          ctx,
        ),
        /signed off/,
      );
      await assert.rejects(
        discardReconciliation(reconciliationId, ctx),
        /Signed-off reconciliations cannot be discarded/,
      );
      await assert.rejects(
        restoreStatementLine(excludedId, ctx),
        /covered by a signed-off reconciliation/,
      );
      await assert.rejects(
        db.execute(sql`
          update journal_lines
             set reconciled_at = null, reconciliation_id = null
           where id = ${hundred[0]} and org_id = ${org.orgId}
        `),
        (error: unknown) =>
          errorChainMatches(error, /reconciliation evidence is append-only/),
      );
      await assert.rejects(
        db.execute(sql`
          delete from reconciliation_matches
           where reconciliation_id = ${reconciliationId}
             and journal_line_id = ${hundred[0]}
        `),
        (error: unknown) =>
          errorChainMatches(error, /signed-off reconciliation matches are immutable/),
      );
      await assert.rejects(
        db.execute(sql`
          update bank_statement_lines
             set amount = '999.0000'
           where id = ${statementByRef.get("bank-deposit-100")!}
             and org_id = ${org.orgId}
        `),
        (error: unknown) =>
          errorChainMatches(error, /statement (content|evidence) is immutable/),
      );

      const evidence = (await db.execute<{
          exclusions: number;
          restores: number;
          signoffs: number;
          stamped: number;
        }>(sql`
        select
          (select count(*)::int
             from audit_log
            where org_id = ${org.orgId}
              and table_name = 'bank_statement_lines'
              and row_id = ${excludedId}
              and changes->>'operation' = 'exclude') as exclusions,
          (select count(*)::int
             from audit_log
            where org_id = ${org.orgId}
              and table_name = 'bank_statement_lines'
              and row_id = ${excludedId}
              and changes->>'operation' = 'restore_exclusion') as restores,
          (select count(*)::int
             from audit_log
            where org_id = ${org.orgId}
              and table_name = 'reconciliations'
              and row_id = ${reconciliationId}
              and action = 'approve') as signoffs,
          (select count(*)::int
             from journal_lines
            where org_id = ${org.orgId}
              and reconciliation_id = ${reconciliationId}
              and reconciled_at is not null) as stamped
      `));
      assert.deepEqual(evidence.rows[0], {
        exclusions: 2,
        restores: 1,
        signoffs: 1,
        stamped: 3,
      });
      assert.equal(hundred.length, 1);
    } finally {
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reversed journal entries are unavailable to automatic and manual bank matching",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      const [reversedLineId] = await postBankJournal(org, actor, ["100.0000"], "reversed");
      const reversedEntryId = (await db.execute<{ id: string }>(sql`
        select entry_id as id from journal_lines where id = ${reversedLineId} and org_id = ${org.orgId}`)).rows[0]!.id;
      // Finding 5.2: posted→reversed needs a posted same-book mirror.
      const mirrorId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
        values (${mirrorId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`BANK-reversed-mirror-${mirrorId.slice(0, 8)}`},
                ${org.date}, ${org.periodId}, 'mirror', 'draft', 'manual', ${reversedEntryId}, ${actor}, ${actor})`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        select ${org.orgId}, ${mirrorId}, line_number, account_id, subsidiary_id, -amount, currency, -txn_amount, fx_rate, memo
          from journal_lines where entry_id = ${reversedEntryId} and org_id = ${org.orgId} order by line_number`);
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${mirrorId}`);
      await db.execute(sql`
        update journal_entries
           set status = 'reversed'
         where id = ${reversedEntryId}
           and org_id = ${org.orgId}
      `);
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          statementDate: org.date,
          openingBalance: "0",
          closingBalance: "100",
          currency: "CAD",
          lines: [
            {
              postedOn: org.date,
              amount: "100",
              description: "Voided deposit",
              bankTransactionId: "reversed-deposit",
            },
          ],
        },
        ctx,
      );
      const reconciliation = await startReconciliation(
        {
          accountId: org.accounts.bank,
          throughDate: org.date,
          statementBalance: "100",
        },
        ctx,
      );
      const statementLineId = (
        await db.execute<{ id: string }>(sql`
          select id
            from bank_statement_lines
           where org_id = ${org.orgId} and bank_transaction_id = 'reversed-deposit'
        `)
      ).rows[0]!.id;

      const automatic = await autoMatch(reconciliation.id, ctx);
      assert.equal(automatic.matched, 0);
      await assert.rejects(
        createMatch(
          {
            reconciliationId: reconciliation.id,
            statementLineId,
            journalLineIds: [reversedLineId!],
          },
          ctx,
        ),
        /unavailable/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "restoring an exclusion waits for overlapping reconciliation locks",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          statementDate: org.date,
          openingBalance: "0",
          closingBalance: "5",
          currency: "CAD",
          lines: [
            {
              postedOn: org.date,
              amount: "5",
              description: "Pending exclusion",
              bankTransactionId: "restore-lock",
            },
          ],
        },
        ctx,
      );
      const reconciliation = await startReconciliation(
        {
          accountId: org.accounts.bank,
          throughDate: org.date,
          statementBalance: "0",
        },
        ctx,
      );
      const statementLineId = (
        await db.execute<{ id: string }>(sql`
          select id
            from bank_statement_lines
           where org_id = ${org.orgId} and bank_transaction_id = 'restore-lock'
        `)
      ).rows[0]!.id;
      await excludeStatementLine(statementLineId, "Pending reconciliation lock", ctx);

      let lockReady!: () => void;
      const reconciliationLocked = new Promise<void>((resolve) => {
        lockReady = resolve;
      });
      let releaseLock!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const locker = db.transaction(async (tx) => {
        await tx.execute(sql`
          select id
            from reconciliations
           where id = ${reconciliation.id} and org_id = ${org.orgId}
           for update
        `);
        lockReady();
        await release;
      });

      await reconciliationLocked;
      let restored = false;
      let restoreError: unknown;
      const restore = restoreStatementLine(statementLineId, ctx).then(
        () => {
          restored = true;
        },
        (error: unknown) => {
          restoreError = error;
        },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(restored, false, "restore must wait for the reconciliation row lock");
      } finally {
        releaseLock();
      }
      await locker;
      await restore;
      if (restoreError) throw restoreError;
      assert.equal(restored, true);
      const status = (
        await db.execute<{ match_status: string }>(sql`
          select match_status
            from bank_statement_lines
           where id = ${statementLineId} and org_id = ${org.orgId}
        `)
      ).rows[0]!.match_status;
      assert.equal(status, "unmatched");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "importing statement lines inside signed-off coverage is refused",
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      await postBankJournal(org, actor, ["100"], "covered");
      const statementInput = {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        openingBalance: "0",
        closingBalance: "100",
        currency: "CAD",
        lines: [
          {
            postedOn: org.date,
            amount: "100",
            description: "Covered deposit",
            bankTransactionId: "covered-deposit",
          },
        ],
      };
      await importStatement(statementInput, ctx);
      const reconciliation = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100" },
        ctx,
      );
      assert.equal((await autoMatch(reconciliation.id, ctx)).matched, 1);
      assert.deepEqual(await markReconciled(reconciliation.id, ctx), { journalLinesReconciled: 1 });

      // A late-arriving but distinct transaction dated inside the signed
      // coverage must refuse — signed-off history is immutable and the
      // closed session could never clear the new unmatched line.
      await assert.rejects(
        importStatement(
          {
            accountId: org.accounts.bank,
            source: "manual" as const,
            statementDate: org.date,
            currency: "CAD",
            lines: [
              {
                postedOn: org.date,
                amount: "7",
                description: "Late fee inside signed coverage",
                bankTransactionId: "late-fee-signed",
              },
            ],
          },
          ctx,
        ),
        /signed-off/,
      );
      // The preview refuses the same way — it must agree with the import.
      await assert.rejects(
        importStatement(
          {
            accountId: org.accounts.bank,
            source: "manual" as const,
            statementDate: org.date,
            currency: "CAD",
            dryRun: true,
            lines: [
              {
                postedOn: org.date,
                amount: "7",
                description: "Late fee inside signed coverage",
                bankTransactionId: "late-fee-signed",
              },
            ],
          },
          ctx,
        ),
        /signed-off/,
      );
      // Lines after the signed cutoff still import.
      const dayAfter = new Date(Date.parse(`${org.date}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const later = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual" as const,
          statementDate: dayAfter,
          currency: "CAD",
          lines: [
            {
              postedOn: dayAfter,
              amount: "7",
              description: "Next-day fee",
              bankTransactionId: "next-day-fee",
            },
          ],
        },
        ctx,
      );
      assert.equal(later.imported, 1);
      // And retrying the already-imported file stays idempotent —
      // grandfathered duplicates never trip the cutoff.
      const retry = await importStatement(statementInput, ctx);
      assert.equal(retry.statementId, null);
      assert.equal(retry.duplicates, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "re-importing a re-exported ID-less month imports only genuinely new rows",
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      // Two genuine $5 coffees on the same day: content-identical, both real.
      const month = [
        { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
        { postedOn: org.date, amount: "-5.0000", description: "coffee shop" },
        { postedOn: org.date, amount: "100.0000", description: "PAYROLL" },
      ];
      const first = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: month,
        },
        ctx,
      );
      assert.equal(first.imported, 3);
      assert.equal(first.duplicates, 0);

      // The bank re-exports the month: same lines reordered with reflowed
      // descriptions, plus one genuinely new trailing row.
      const reexport = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "100.0000", description: "payroll" },
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE  SHOP" },
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
            { postedOn: org.date, amount: "-7.5000", description: "LATE FEE" },
          ],
        },
        ctx,
      );
      assert.equal(reexport.imported, 1);
      assert.equal(reexport.duplicates, 3);

      // The account holds four lines, each with a distinct synthesized ID —
      // the re-export neither doubled the month nor merged the twin coffees.
      const stored = await db.execute<{ bank_transaction_id: string }>(sql`
        select bank_transaction_id from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
      `);
      assert.equal(stored.rows.length, 4);
      assert.equal(
        new Set(stored.rows.map((row) => row.bank_transaction_id)).size,
        4,
      );
      for (const row of stored.rows) {
        assert.match(row.bank_transaction_id, /^synth-v1:[0-9a-f]{64}$/);
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "sign-off refuses when the imported closing balance disagrees with the session balance",
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      await postBankJournal(org, actor, ["100"], "closing-check");
      // The bank's own figure for the cutoff is 90, but the session was
      // typed as 100: the GL must not balance against a number the bank
      // never reported.
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual" as const,
          statementDate: org.date,
          openingBalance: "0",
          closingBalance: "90",
          currency: "CAD",
          lines: [
            {
              postedOn: org.date,
              amount: "100",
              description: "Closing-check deposit",
              bankTransactionId: "closing-check-deposit",
            },
          ],
        },
        ctx,
      );
      const reconciliation = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100" },
        ctx,
      );
      assert.equal((await autoMatch(reconciliation.id, ctx)).matched, 1);
      await assert.rejects(
        markReconciled(reconciliation.id, ctx),
        /closing balance 90.*session statement balance 100|session statement balance 100.*closing balance 90/,
      );
      // The named remedy — adjusting the session to the imported closing —
      // clears this gate (the genuine 10 imbalance then surfaces as a
      // difference, not a silent sign-off).
      await adjustReconciliation(reconciliation.id, { statementBalance: "90" }, ctx);
      await assert.rejects(markReconciled(reconciliation.id, ctx), /difference is -10\.0000/);
      const status = (await db.execute<{ status: string }>(sql`
        select status from reconciliations where id = ${reconciliation.id} and org_id = ${org.orgId}
      `)).rows[0]!.status;
      assert.notEqual(status, "signed_off");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
