import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  adjustReconciliation,
  autoMatch,
  BankingError,
  clearPossibleDuplicateFlag,
  createMatch,
  discardReconciliation,
  excludePossibleDuplicates,
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
  "separate ID-less files with distinct balances keep both lines, flagged; the identical file still dedupes",
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
      const fileA = {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        openingBalance: "1000",
        closingBalance: "1090",
        currency: "CAD",
        // Two genuine $5 coffees on the same day: content-identical, both
        // real, both import clean on first sight.
        lines: [
          { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
          { postedOn: org.date, amount: "-5.0000", description: "coffee shop" },
          { postedOn: org.date, amount: "100.0000", description: "PAYROLL" },
        ],
      };
      const first = await importStatement(fileA, ctx);
      assert.equal(first.imported, 3);
      assert.equal(first.duplicates, 0);
      assert.equal(first.possibleDuplicates, 0);
      assert.deepEqual(first.lines.map((line) => line.possibleDuplicateOf), [null, null, null]);

      // An independent second file carries the same content with DISTINCT
      // balances: no replay proof exists, so nothing may vanish. Both
      // overlapping lines import flagged against the earlier import.
      const preview = await importStatement(
        {
          ...fileA,
          openingBalance: "2000",
          closingBalance: "2090",
          lines: [
            { postedOn: org.date, amount: "100.0000", description: "payroll" },
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE  SHOP" },
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
          ],
          dryRun: true,
        },
        ctx,
      );
      assert.equal(preview.statementId, null);
      assert.equal(preview.imported, 3);
      assert.equal(preview.duplicates, 0);
      assert.equal(preview.possibleDuplicates, 3);
      assert.equal(
        preview.lines.filter((line) => line.possibleDuplicateOf).length,
        3,
      );
      const second = await importStatement(
        {
          ...fileA,
          openingBalance: "2000",
          closingBalance: "2090",
          lines: [
            { postedOn: org.date, amount: "100.0000", description: "payroll" },
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE  SHOP" },
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
          ],
        },
        ctx,
      );
      assert.equal(second.imported, 3);
      assert.equal(second.duplicates, 0);
      assert.equal(second.possibleDuplicates, 3);

      // Every flagged line points at an earlier line with the same content,
      // and ID-less imports store no synthetic bank key.
      const stored = await db.execute<{
        id: string;
        bank_transaction_id: string | null;
        possible_duplicate_of: string | null;
      }>(sql`
        select id, bank_transaction_id, possible_duplicate_of
          from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
      `);
      assert.equal(stored.rows.length, 6);
      for (const row of stored.rows) assert.equal(row.bank_transaction_id, null);
      const flagged = stored.rows.filter((row) => row.possible_duplicate_of);
      assert.equal(flagged.length, 3);
      const earlierIds = new Set(
        stored.rows.filter((row) => !row.possible_duplicate_of).map((row) => row.id),
      );
      for (const row of flagged) assert.ok(earlierIds.has(row.possible_duplicate_of!));

      // Replaying the identical first file still dedupes cleanly.
      const retry = await importStatement(fileA, ctx);
      assert.equal(retry.statementId, null);
      assert.equal(retry.imported, 0);
      assert.equal(retry.duplicates, 3);
      assert.equal(retry.possibleDuplicates, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an equal closing balance on a distinct file never drops a genuine twin",
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
      const first = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual" as const,
          statementDate: org.date,
          openingBalance: "1000",
          closingBalance: "995",
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
          ],
        },
        ctx,
      );
      assert.equal(first.imported, 1);
      assert.equal(first.duplicates, 0);

      // A distinct second file ends on the same closing balance — offsetting
      // activity in between restores it. A balance match is not transaction
      // identity, so the genuine second coffee imports flagged, never drops.
      const second = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual" as const,
          statementDate: org.date,
          openingBalance: "1005",
          closingBalance: "995",
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
            { postedOn: org.date, amount: "-5.0000", description: "SNACK BAR" },
          ],
        },
        ctx,
      );
      assert.equal(second.imported, 2);
      assert.equal(second.duplicates, 0);
      assert.equal(second.possibleDuplicates, 1);
      const [coffee, snack] = second.lines;
      assert.ok(coffee!.possibleDuplicateOf);
      assert.equal(snack!.possibleDuplicateOf, null);

      // The flag points at the earlier file's line, and all lines persist.
      const stored = await db.execute<{
        id: string;
        description: string | null;
        possible_duplicate_of: string | null;
      }>(sql`
        select id, description, possible_duplicate_of
          from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
      `);
      assert.equal(stored.rows.length, 3);
      const earlier = stored.rows.find((row) => !row.possible_duplicate_of)!;
      assert.equal(earlier.description, "COFFEE SHOP");
      assert.equal(coffee!.possibleDuplicateOf, earlier.id);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("parser-skipped rows are reported in the preview and the import", async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const ctx = { orgId: org.orgId, userId: actor };
    await db.execute(sql`
      update accounts
         set reconcilable = true, currency_restriction = 'CAD'
       where id = ${org.accounts.bank} and org_id = ${org.orgId}
    `);
    const skipped = [{ line: 1, code: "csv_metadata_row" as const, dateCell: "Bank export" }];
    const preview = await importStatement(
      {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        openingBalance: "1000",
        closingBalance: "995",
        currency: "CAD",
        lines: [{ postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" }],
        skippedLines: skipped,
        dryRun: true,
      },
      ctx,
    );
    assert.deepEqual(preview.skipped, skipped);
    const imported = await importStatement(
      {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        openingBalance: "1000",
        closingBalance: "995",
        currency: "CAD",
        lines: [{ postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" }],
        skippedLines: skipped,
      },
      ctx,
    );
    assert.deepEqual(imported.skipped, skipped);
    // The skipped row is reported, never written.
    const stored = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from bank_statement_lines
       where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
    `));
    assert.equal(stored.rows[0]!.n, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "discarding a session writes one audit row with the match count and session summary",
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
      const [bankLineId] = await postBankJournal(org, actor, ["100.0000"], "discard-deposit");
      await importStatement(
        {
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
              description: "Customer deposit",
              bankTransactionId: "discard-deposit-100",
            },
          ],
        },
        ctx,
      );
      const lineId = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and bank_transaction_id = 'discard-deposit-100'
      `)).rows[0]!.id;
      const { id: reconciliationId } = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100" },
        ctx,
      );
      await createMatch(
        { reconciliationId, statementLineId: lineId, journalLineIds: [bankLineId!] },
        ctx,
      );

      await discardReconciliation(reconciliationId, ctx);

      // The session is gone and its line is released — and the delete left
      // evidence instead of silence, atomically with the delete above.
      const gone = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from reconciliations
         where id = ${reconciliationId} and org_id = ${org.orgId}
      `));
      assert.equal(gone.rows[0]!.n, 0);
      const line = (await db.execute<{ match_status: string }>(sql`
        select match_status from bank_statement_lines where id = ${lineId}
      `));
      assert.equal(line.rows[0]!.match_status, "unmatched");
      const audits = (await db.execute<{ changes: Record<string, unknown>; actor_id: string }>(sql`
        select changes, actor_id from audit_log
         where org_id = ${org.orgId}
           and table_name = 'reconciliations'
           and row_id = ${reconciliationId}
           and action = 'discard'
      `));
      assert.equal(audits.rows.length, 1);
      assert.deepEqual(audits.rows[0]!.changes, {
        operation: "discard",
        releasedMatches: 1,
        releasedStatementLines: 1,
        before: {
          accountId: org.accounts.bank,
          throughDate: org.date,
          statementBalance: "100.0000",
          currency: "CAD",
          // Balanced, not in_progress: the match above zeroed the difference
          // before the discard, and the audit records the session as found.
          status: "balanced",
        },
      });
      assert.equal(audits.rows[0]!.actor_id, actor);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a re-exported ID-less file with different bytes imports flagged, never skips",
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
      const month = {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        openingBalance: "1000",
        closingBalance: "1090",
        currency: "CAD",
        lines: [
          { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
          { postedOn: org.date, amount: "100.0000", description: "PAYROLL" },
        ],
      };
      const first = await importStatement(month, ctx);
      assert.equal(first.imported, 2);
      // Same window, same balances, rows reordered with a reflowed
      // description: different source bytes, so not an exact replay. A
      // balance match is not transaction identity — both lines import,
      // flagged against the earlier import for review.
      const reexport = await importStatement(
        {
          ...month,
          lines: [
            { postedOn: org.date, amount: "100.0000", description: "payroll" },
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE  SHOP" },
          ],
        },
        ctx,
      );
      assert.equal(reexport.imported, 2);
      assert.equal(reexport.duplicates, 0);
      assert.equal(reexport.possibleDuplicates, 2);
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

test(
  "flagged lines hold matching until reviewed, then clear or bulk-exclude audited",
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
      const base = {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        currency: "CAD",
        lines: [{ postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" }],
      };
      await importStatement({ ...base, openingBalance: "1000", closingBalance: "995" }, ctx);
      const second = await importStatement(
        { ...base, openingBalance: "2000", closingBalance: "1995" },
        ctx,
      );
      assert.equal(second.possibleDuplicates, 1);
      const flaggedId = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
           and possible_duplicate_of is not null
      `)).rows[0]!.id;

      const [journalLineId] = await postBankJournal(org, actor, ["-5.0000"], "flagged-coffee");
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "1990" },
        ctx,
      );
      // Manual matching refuses the flagged line by name.
      await assert.rejects(
        createMatch(
          { reconciliationId: recon.id, statementLineId: flaggedId, journalLineIds: [journalLineId!] },
          ctx,
        ),
        /possible duplicate/,
      );
      // Auto-match sweeps around it: the unflagged twin matches, the flagged
      // line stays unmatched — and sign-off still counts it.
      assert.equal((await autoMatch(recon.id, ctx)).matched, 1);
      assert.equal((await reconciliationTotals(recon.id, ctx)).unmatchedStatementLines, 1);

      // Review clears the flag with an audit row naming the evidence...
      await clearPossibleDuplicateFlag(flaggedId, ctx);
      const clears = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${org.orgId} and table_name = 'bank_statement_lines'
           and row_id = ${flaggedId} and action = 'update'
           and changes->>'operation' = 'clear_possible_duplicate'
           and changes->'before'->>'possibleDuplicateOf' is not null
           and actor_id = ${actor}
      `)).rows[0]!.n;
      assert.equal(clears, 1);
      // ...and the cleared line matches normally afterwards.
      const [journalLineId2] = await postBankJournal(org, actor, ["-5.0000"], "cleared-coffee");
      await createMatch(
        { reconciliationId: recon.id, statementLineId: flaggedId, journalLineIds: [journalLineId2!] },
        ctx,
      );
      // Clearing an unflagged line refuses instead of no-op success.
      const unflaggedId = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
           and possible_duplicate_of is null and match_status = 'matched'
         limit 1
      `)).rows[0]!.id;
      await assert.rejects(clearPossibleDuplicateFlag(unflaggedId, ctx), /Only flagged/);

      // A third overlapping file flags again, and the bulk review excludes
      // every flagged line with one audited row per line.
      const third = await importStatement(
        { ...base, openingBalance: "3000", closingBalance: "2995" },
        ctx,
      );
      assert.equal(third.possibleDuplicates, 1);
      const bulk = await excludePossibleDuplicates(
        org.accounts.bank,
        "Duplicate of an earlier import (reviewed in bulk)",
        ctx,
      );
      assert.equal(bulk.excluded, 1);
      const excluded = (await db.execute<{
        match_status: string;
        exclusion_reason: string | null;
        possible_duplicate_of: string | null;
      }>(sql`
        select match_status, exclusion_reason, possible_duplicate_of
          from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
           and match_status = 'excluded'
      `));
      assert.equal(excluded.rows.length, 1);
      assert.equal(excluded.rows[0]!.exclusion_reason, "Duplicate of an earlier import (reviewed in bulk)");
      assert.ok(excluded.rows[0]!.possible_duplicate_of, "the flag is kept as exclusion evidence");
      const bulkAudits = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${org.orgId} and table_name = 'bank_statement_lines'
           and action = 'update' and changes->>'operation' = 'exclude'
           and (changes->>'bulk')::boolean is true and actor_id = ${actor}
      `)).rows[0]!.n;
      assert.equal(bulkAudits, 1);
      // A second bulk run finds nothing left to exclude.
      assert.equal(
        (await excludePossibleDuplicates(org.accounts.bank, "Duplicate of an earlier import (reviewed in bulk)", ctx)).excluded,
        0,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
