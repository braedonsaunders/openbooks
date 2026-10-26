import { before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  BankingError,
  correctStatementBalances,
  correctStatementLine,
  createGlClearingGroup,
  createMatch,
  deleteStatementImport,
  excludeStatementLine,
  importStatement,
  markReconciled,
  restoreStatementLine,
  startReconciliation,
  unmatchStatementImport,
} from "./banking.ts";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type CsvImportInput = Omit<Parameters<typeof importStatement>[0], "source" | "sourceEvidence"> & {
  source: "csv";
};

/**
 * Import fixture lines as the bank CSV file they stand for. CSV imports must
 * retain the column mapping used to parse the file, so the fixture renders
 * the lines into deterministic CSV bytes with that mapping: an identical
 * input reproduces the identical file (and source hash).
 */
function importCsv(
  input: CsvImportInput,
  ctx: Parameters<typeof importStatement>[1],
  dryRun = false,
) {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const content =
    [
      "date,amount,description,bank_transaction_id",
      ...input.lines.map((line) =>
        [
          line.postedOn,
          line.amount,
          quote(line.description ?? ""),
          line.bankTransactionId ?? "",
        ].join(","),
      ),
    ].join("\n") + "\n";
  return importStatement(
    {
      ...input,
      dryRun,
      sourceEvidence: {
        content,
        filename: "statement.csv",
        contentType: "text/csv",
        csvMapping: {
          date: 0,
          amount: 1,
          description: 2,
          bankTransactionId: 3,
        },
      },
    },
    ctx,
  );
}

async function postBankLine(
  org: ScratchOrg,
  actorId: string,
  bankAmount: string,
  label: string,
  date?: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`BAL-${label}-${entryId.slice(0, 8)}`}, ${date ?? org.date}, ${org.periodId},
         ${`Balance ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const offsetAmount = bankAmount.startsWith("-") ? bankAmount.slice(1) : `-${bankAmount}`;
    const [bankLine] = await tx.execute<{ id: string }>(
      sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1,
         ${org.accounts.bank}, ${org.subsidiaryId}, ${bankAmount}, 'CAD',
         ${bankAmount}, 1, ${label}),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 2,
         ${org.accounts.adjustment}, ${org.subsidiaryId}, ${offsetAmount}, 'CAD',
         ${offsetAmount}, 1, ${label})
      returning id
    `,
      "objects",
    );
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return bankLine!.id;
  });
}

async function setup() {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update accounts
       set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  return {
    org,
    actor,
    ctx: { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null },
  };
}

async function storedBalances(orgId: string, statementId: string) {
  return (
    await db.execute<{
      opening_balance: string | null;
      closing_balance: string | null;
    }>(
      sql`
    select opening_balance::text as opening_balance, closing_balance::text as closing_balance
      from bank_statements where id = ${statementId} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0]!;
}

test(
  "CSV balances are set on the imported statement before any match, audited",
  { skip: !DB },
  async () => {
    const { org, ctx } = await setup();
    try {
      // A CSV carries no bank-reported balances, so the statement imports
      // with none — the operator sets them before matching starts.
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            {
              postedOn: org.date,
              amount: "100.00",
              description: "Client receipt",
              bankTransactionId: "receipt",
            },
          ],
        },
        ctx,
      );
      assert.deepEqual(await storedBalances(org.orgId, imported.statementId!), {
        opening_balance: null,
        closing_balance: null,
      });
      const after = await correctStatementBalances(
        imported.statementId!,
        { openingBalance: "1000.00", closingBalance: "1100.00" },
        ctx,
      );
      assert.deepEqual(after, {
        openingBalance: "1000.0000",
        closingBalance: "1100.0000",
      });
      assert.deepEqual(await storedBalances(org.orgId, imported.statementId!), {
        opening_balance: "1000.0000",
        closing_balance: "1100.0000",
      });
      const audits = (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n from audit_log
         where org_id = ${org.orgId} and table_name = 'bank_statements'
           and row_id = ${imported.statementId!} and action = 'update'
           and changes->>'operation' = 'correct_balances'
      `,
          "objects",
        )
      )[0]!.n;
      assert.equal(audits, 1, "the balance correction is audited with a before/after image");
      await assert.rejects(
        correctStatementBalances(imported.statementId!, {}, ctx),
        /No balance supplied/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("statement balances refuse once a line is matched", { skip: !DB }, async () => {
  const { org, actor, ctx } = await setup();
  try {
    const journal = await postBankLine(org, actor, "100.00", "receipt");
    const imported = await importCsv(
      {
        accountId: org.accounts.bank,
        source: "csv" as const,
        statementDate: org.date,
        currency: "CAD",
        lines: [
          {
            postedOn: org.date,
            amount: "100.00",
            description: "Client receipt",
            bankTransactionId: "receipt",
          },
        ],
      },
      ctx,
    );
    const [receipt] = (
      await db.execute<{ id: string }>(
        sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `,
        "objects",
      )
    ).map((row) => row.id);
    const recon = await startReconciliation(
      {
        accountId: org.accounts.bank,
        throughDate: org.date,
        statementBalance: "100.00",
      },
      ctx,
    );
    await createMatch(
      {
        reconciliationId: recon.id,
        statementLineIds: [receipt!],
        journalLineIds: [journal!],
      },
      ctx,
    );
    await assert.rejects(
      correctStatementBalances(imported.statementId!, { closingBalance: "100.00" }, ctx),
      /unmatch them first/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "pre-carry book lines clear as a zero-sum group while the carry still proves",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      // A 5,000.00 book opening with no bank line predates the statement
      // coverage, as does a voided 200.00 deposit and its correction.
      await postBankLine(org, actor, "5000.00", "book-opening", "2026-10-01");
      const voided = await postBankLine(org, actor, "200.00", "voided-deposit", "2026-10-02");
      const correction = await postBankLine(org, actor, "-200.00", "correction", "2026-10-03");
      const receipt = await postBankLine(org, actor, "300.00", "receipt", "2026-11-05");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-11-30",
          currency: "CAD",
          openingBalance: "5000.00",
          lines: [
            {
              postedOn: "2026-11-05",
              amount: "300.00",
              description: "Client receipt",
              bankTransactionId: "receipt",
            },
          ],
        },
        ctx,
      );
      const [receiptLine] = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `,
          "objects",
        )
      ).map((row) => row.id);
      const recon = await startReconciliation(
        {
          accountId: org.accounts.bank,
          throughDate: "2026-11-30",
          statementBalance: "5300.00",
        },
        ctx,
      );
      await createMatch(
        {
          reconciliationId: recon.id,
          statementLineIds: [receiptLine!],
          journalLineIds: [receipt!],
        },
        ctx,
      );
      // The pre-carry pair nets to zero, so clearing it cannot double-count
      // the 5,000.00 opening the carry proves from the same history.
      await createGlClearingGroup(
        { reconciliationId: recon.id, journalLineIds: [voided!, correction!] },
        ctx,
      );
      const signed = await markReconciled(recon.id, ctx);
      assert.equal(
        signed.status,
        "signed_off",
        "The zero-gate submission must complete its native outcome",
      );
      if (signed.status !== "signed_off")
        throw new Error("The zero-gate submission unexpectedly awaits approval.");
      assert.equal(signed.journalLinesReconciled, 3, "receipt plus both cleared lines stamp");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("unmatch-all releases an import so its delete succeeds", { skip: !DB }, async () => {
  const { org, actor, ctx } = await setup();
  try {
    const first = await postBankLine(org, actor, "100.00", "first");
    const second = await postBankLine(org, actor, "200.00", "second");
    const imported = await importCsv(
      {
        accountId: org.accounts.bank,
        source: "csv" as const,
        statementDate: org.date,
        currency: "CAD",
        lines: [
          {
            postedOn: org.date,
            amount: "100.00",
            description: "First receipt",
            bankTransactionId: "first",
          },
          {
            postedOn: org.date,
            amount: "200.00",
            description: "Second receipt",
            bankTransactionId: "second",
          },
        ],
      },
      ctx,
    );
    const lineIds = (
      await db.execute<{ id: string }>(
        sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
         order by line_number
      `,
        "objects",
      )
    ).map((row) => row.id);
    const recon = await startReconciliation(
      {
        accountId: org.accounts.bank,
        throughDate: org.date,
        statementBalance: "300.00",
      },
      ctx,
    );
    await createMatch(
      {
        reconciliationId: recon.id,
        statementLineIds: lineIds,
        journalLineIds: [first!, second!],
      },
      ctx,
    );
    await assert.rejects(deleteStatementImport(imported.statementId!, ctx), /unmatch them first/);
    const released = await unmatchStatementImport(imported.statementId!, ctx);
    assert.equal(released.unmatchedGroups, 1);
    assert.equal(released.unmatchedLines, 2);
    const deleted = await deleteStatementImport(imported.statementId!, ctx);
    assert.equal(deleted.deletedLines, 2, "the released import deletes");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function typedDeleteRefusal(promise: Promise<unknown>, pattern: RegExp, label: string) {
  // QA-154: every guarded state must refuse with a typed BankingError (the
  // route renders those as 422 with a remedy). Anything else — a bare
  // TypeError, a trigger raise — reaches the operator as a 500.
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(error instanceof BankingError, `${label} must refuse typed, got ${String(error)}`);
  assert.match((error as Error).message, pattern);
}

test("delete refuses every guarded state typed, never a bare failure", { skip: !DB }, async () => {
  const a = await setup();
  const b = await setup();
  try {
    // Open-session states live in the first org: one matched line, one
    // excluded line, and a duplicate pointer aimed at the excluded one.
    const first = await postBankLine(a.org, a.actor, "100.00", "first");
    const matchedImport = await importCsv(
      {
        accountId: a.org.accounts.bank,
        source: "csv" as const,
        statementDate: a.org.date,
        currency: "CAD",
        lines: [
          {
            postedOn: a.org.date,
            amount: "100.00",
            description: "Matched receipt",
            bankTransactionId: "m1",
          },
        ],
      },
      a.ctx,
    );
    const excludedImport = await importCsv(
      {
        accountId: a.org.accounts.bank,
        source: "csv" as const,
        statementDate: a.org.date,
        currency: "CAD",
        lines: [
          {
            postedOn: a.org.date,
            amount: "200.00",
            description: "Excluded receipt",
            bankTransactionId: "x1",
          },
        ],
      },
      a.ctx,
    );
    const lineId = async (orgId: string, statementId: string) =>
      (
        await db.execute<{ id: string }>(
          sql`
          select id from bank_statement_lines
           where org_id = ${orgId} and statement_id = ${statementId}
        `,
          "objects",
        )
      )[0]!.id;
    const matchedLineId = await lineId(a.org.orgId, matchedImport.statementId!);
    const excludedLineId = await lineId(a.org.orgId, excludedImport.statementId!);
    const recon = await startReconciliation(
      {
        accountId: a.org.accounts.bank,
        throughDate: a.org.date,
        statementBalance: "100.00",
      },
      a.ctx,
    );
    await createMatch(
      {
        reconciliationId: recon.id,
        statementLineIds: [matchedLineId!],
        journalLineIds: [first!],
      },
      a.ctx,
    );
    // Matched in an open session: unmatch first.
    await typedDeleteRefusal(
      deleteStatementImport(matchedImport.statementId!, a.ctx),
      /unmatch them first/,
      "matched-open",
    );
    // Excluded lines carry a review decision: restore first.
    await excludeStatementLine(excludedLineId!, "opening-balance row, not a transaction", a.ctx);
    await typedDeleteRefusal(
      deleteStatementImport(excludedImport.statementId!, a.ctx),
      /restore them first/,
      "excluded",
    );
    // Another line's possible-duplicate pointer into this import is that
    // line's review evidence: clear those flags first. Restore the
    // excluded line so the pointer fence is the one that fires.
    await restoreStatementLine(excludedLineId!, a.ctx);
    await db.execute(sql`
        update bank_statement_lines
           set possible_duplicate_of = ${excludedLineId}, updated_at = now(), updated_by = ${a.actor}
         where id = ${matchedLineId} and org_id = ${a.org.orgId}
      `);
    await typedDeleteRefusal(
      deleteStatementImport(excludedImport.statementId!, a.ctx),
      /clear those flags first/,
      "inbound-flag",
    );
    await db.execute(sql`
        update bank_statement_lines
           set possible_duplicate_of = null, updated_at = now(), updated_by = ${a.actor}
         where id = ${matchedLineId} and org_id = ${a.org.orgId}
      `);
    // The second org closes cleanly then receives a backdated import:
    // every line unmatched, yet inside signed-off history — immutable.
    const journal = await postBankLine(b.org, b.actor, "100.00", "receipt");
    const closedImport = await importCsv(
      {
        accountId: b.org.accounts.bank,
        source: "csv" as const,
        statementDate: b.org.date,
        currency: "CAD",
        lines: [
          {
            postedOn: b.org.date,
            amount: "100.00",
            description: "Client receipt",
            bankTransactionId: "r1",
          },
        ],
      },
      b.ctx,
    );
    const receiptLineId = await lineId(b.org.orgId, closedImport.statementId!);
    const closed = await startReconciliation(
      {
        accountId: b.org.accounts.bank,
        throughDate: b.org.date,
        statementBalance: "100.00",
      },
      b.ctx,
    );
    await createMatch(
      {
        reconciliationId: closed.id,
        statementLineIds: [receiptLineId!],
        journalLineIds: [journal!],
      },
      b.ctx,
    );
    await markReconciled(closed.id, b.ctx);
    // Matched inside a signed-off session: still typed (unmatch first —
    // and unmatching itself refuses the closed session, so the chain
    // ends here, loudly, instead of a 500).
    await typedDeleteRefusal(
      deleteStatementImport(closedImport.statementId!, b.ctx),
      /unmatch them first/,
      "matched-in-signed-off",
    );
    await typedDeleteRefusal(
      unmatchStatementImport(closedImport.statementId!, b.ctx),
      /signed-off history is immutable/,
      "unmatch-in-signed-off",
    );
  } finally {
    await dropScratchOrg(a.org.orgId);
    await dropScratchOrg(b.org.orgId);
  }
});

test("correction refuses to backdate a line into signed-off history", { skip: !DB }, async () => {
  const { org, actor, ctx } = await setup();
  try {
    // Close July cleanly, then import an August line: the import fence
    // keeps it out of July, and correction refuses to move it back in —
    // the loop into closed history stays shut at every verb.
    const july = await postBankLine(org, actor, "100.00", "july", "2026-07-15");
    const julyImport = await importCsv(
      {
        accountId: org.accounts.bank,
        source: "csv" as const,
        statementDate: "2026-07-15",
        currency: "CAD",
        lines: [
          {
            postedOn: "2026-07-15",
            amount: "100.00",
            description: "July receipt",
            bankTransactionId: "j1",
          },
        ],
      },
      ctx,
    );
    const julyLineId = (
      await db.execute<{ id: string }>(
        sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${julyImport.statementId!}
      `,
        "objects",
      )
    )[0]!.id;
    const julyRecon = await startReconciliation(
      {
        accountId: org.accounts.bank,
        throughDate: "2026-07-15",
        statementBalance: "100.00",
      },
      ctx,
    );
    await createMatch(
      {
        reconciliationId: julyRecon.id,
        statementLineIds: [julyLineId!],
        journalLineIds: [july!],
      },
      ctx,
    );
    await markReconciled(julyRecon.id, ctx);
    const augustImport = await importCsv(
      {
        accountId: org.accounts.bank,
        source: "csv" as const,
        statementDate: "2026-08-05",
        currency: "CAD",
        lines: [
          {
            postedOn: "2026-08-05",
            amount: "200.00",
            description: "August receipt",
            bankTransactionId: "a1",
          },
        ],
      },
      ctx,
    );
    const augustLineId = (
      await db.execute<{ id: string }>(
        sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${augustImport.statementId!}
      `,
        "objects",
      )
    )[0]!.id;
    const correction = await correctStatementLine(
      augustLineId!,
      { postedOn: "2026-07-01" },
      ctx,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(
      correction instanceof BankingError,
      `backdating into history must refuse typed, got ${String(correction)}`,
    );
    assert.match((correction as Error).message, /signed-off history is immutable/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("unmatch-all refuses inside signed-off history", { skip: !DB }, async () => {
  const { org, actor, ctx } = await setup();
  try {
    const journal = await postBankLine(org, actor, "100.00", "receipt");
    const imported = await importCsv(
      {
        accountId: org.accounts.bank,
        source: "csv" as const,
        statementDate: org.date,
        currency: "CAD",
        lines: [
          {
            postedOn: org.date,
            amount: "100.00",
            description: "Client receipt",
            bankTransactionId: "receipt",
          },
        ],
      },
      ctx,
    );
    const [receipt] = (
      await db.execute<{ id: string }>(
        sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `,
        "objects",
      )
    ).map((row) => row.id);
    const recon = await startReconciliation(
      {
        accountId: org.accounts.bank,
        throughDate: org.date,
        statementBalance: "100.00",
      },
      ctx,
    );
    await createMatch(
      {
        reconciliationId: recon.id,
        statementLineIds: [receipt!],
        journalLineIds: [journal!],
      },
      ctx,
    );
    await markReconciled(recon.id, ctx);
    await assert.rejects(
      unmatchStatementImport(imported.statementId!, ctx),
      /signed-off history is immutable/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "opening chains from the prior covered closing and flags a mismatch",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      // July closes at 100.00 and signs off: the August preview defaults
      // its opening from that closing, and a different typed opening flags
      // instead of refusing.
      const journal = await postBankLine(org, actor, "100.00", "july", "2026-07-15");
      const july = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-07-31",
          currency: "CAD",
          closingBalance: "100.00",
          lines: [
            {
              postedOn: "2026-07-15",
              amount: "100.00",
              description: "July receipt",
              bankTransactionId: "j1",
            },
          ],
        },
        ctx,
      );
      const [julyLine] = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${july.statementId!}
      `,
          "objects",
        )
      ).map((row) => row.id);
      const closed = await startReconciliation(
        {
          accountId: org.accounts.bank,
          throughDate: "2026-07-31",
          statementBalance: "100.00",
        },
        ctx,
      );
      await createMatch(
        {
          reconciliationId: closed.id,
          statementLineIds: [julyLine!],
          journalLineIds: [journal!],
        },
        ctx,
      );
      await markReconciled(closed.id, ctx);
      const augustLines: CsvImportInput = {
        accountId: org.accounts.bank,
        source: "csv",
        statementDate: "2026-08-31",
        currency: "CAD",
        lines: [
          {
            postedOn: "2026-08-05",
            amount: "50.00",
            description: "August receipt",
            bankTransactionId: "a1",
          },
        ],
      };
      const chained = await importCsv({ ...augustLines }, ctx, true);
      assert.deepEqual(
        {
          balance: chained.suggestedOpening?.balance,
          date: chained.suggestedOpening?.sourceStatementDate,
        },
        { balance: "100.0000", date: "2026-07-31" },
        "the August opening defaults from the July closing",
      );
      assert.equal(chained.suggestedOpening?.sourceStatementId, july.statementId);
      assert.equal(chained.openingMismatch, null, "no supplied opening, no mismatch");
      const drifted = await importCsv({ ...augustLines, openingBalance: "90.00" }, ctx, true);
      assert.deepEqual(
        drifted.openingMismatch,
        { expected: "100.0000", supplied: "90.0000" },
        "a typed opening that differs flags for review instead of refusing",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "no chained opening without signed-off history, and uncovered closings skip",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      // Nothing closed yet: no suggestion.
      const bare = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-07-31",
          currency: "CAD",
          closingBalance: "500.00",
          lines: [
            {
              postedOn: "2026-07-15",
              amount: "100.00",
              description: "July receipt",
              bankTransactionId: "j1",
            },
          ],
        },
        ctx,
        true,
      );
      assert.equal(bare.suggestedOpening, null, "an unproven closing seeds nothing");
      // Close June at 300 while July stays open with its own 500 closing:
      // August chains from covered June, skipping uncovered July.
      const journal = await postBankLine(org, actor, "300.00", "june", "2026-06-15");
      const june = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-06-30",
          currency: "CAD",
          closingBalance: "300.00",
          lines: [
            {
              postedOn: "2026-06-15",
              amount: "300.00",
              description: "June receipt",
              bankTransactionId: "g1",
            },
          ],
        },
        ctx,
      );
      const [juneLine] = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${june.statementId!}
      `,
          "objects",
        )
      ).map((row) => row.id);
      const closed = await startReconciliation(
        {
          accountId: org.accounts.bank,
          throughDate: "2026-06-30",
          statementBalance: "300.00",
        },
        ctx,
      );
      await createMatch(
        {
          reconciliationId: closed.id,
          statementLineIds: [juneLine!],
          journalLineIds: [journal!],
        },
        ctx,
      );
      await markReconciled(closed.id, ctx);
      const august = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-08-31",
          currency: "CAD",
          lines: [
            {
              postedOn: "2026-08-05",
              amount: "50.00",
              description: "August receipt",
              bankTransactionId: "a1",
            },
          ],
        },
        ctx,
        true,
      );
      assert.deepEqual(
        {
          balance: august.suggestedOpening?.balance,
          date: august.suggestedOpening?.sourceStatementDate,
        },
        { balance: "300.0000", date: "2026-06-30" },
        "the chain skips the uncovered July closing for covered June",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

// Exercise the same native Flow composition installed by application entry points.
before(async () => {
  const { installEngineSeams } = await import("../composition/install.ts");
  installEngineSeams();
});
