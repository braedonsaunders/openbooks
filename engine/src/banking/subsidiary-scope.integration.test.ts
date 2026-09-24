import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Client } from "pg";
import { sql } from "drizzle-orm";
import {
  adjustReconciliation,
  autoMatch,
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
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Banking subsidiary boundary (AUDIT-H): a bank account belongs to the
 * subsidiary in `accounts.subsidiary_id`; a null (shared) account is
 * reconcilable only with unrestricted scope. Every verb below is exercised
 * from both sides of the boundary — an in-scope caller succeeds, an
 * out-of-scope caller gets the uniform not-found and writes nothing.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface TwoEntity {
  orgId: string;
  actor: string;
  date: string;
  bookId: string;
  periodId: string;
  subA: string;
  subB: string;
  bankA: string;
  bankB: string;
  bankShared: string;
  offset: string;
}

async function seedTwoEntity(): Promise<TwoEntity> {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA')
  `);
  const bankB = randomUUID();
  const bankShared = randomUUID();
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children,
       subsidiary_id, currency_restriction)
    values
      (${bankB}, ${org.orgId}, '1011', 'Second entity bank', 'asset_bank',
       false, true, false, true, '[]'::jsonb, '{}'::jsonb, true, ${subB}, 'CAD'),
      (${bankShared}, ${org.orgId}, '1012', 'Shared bank', 'asset_bank',
       false, true, false, true, '[]'::jsonb, '{}'::jsonb, true, null, 'CAD')
  `);
  await db.execute(sql`
    update accounts set reconcilable = true, currency_restriction = 'CAD',
           subsidiary_id = ${org.subsidiaryId}
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  return {
    orgId: org.orgId,
    actor,
    date: org.date,
    bookId: org.bookId,
    periodId: org.periodId,
    subA: org.subsidiaryId,
    subB,
    bankA: org.accounts.bank,
    bankB,
    bankShared,
    offset: org.accounts.adjustment,
  };
}

/** Post one balanced bank entry by direct SQL, like the banking suites do. */
async function postBankLine(
  fx: TwoEntity,
  opts: { account: string; sub: string; amount: string; tag: string },
): Promise<string> {
  const entryId = randomUUID();
  const bankLineId = randomUUID();
  const offsetAmount = fromUnits(-toUnits(opts.amount));
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
       period_id, memo, status, origin, created_by, updated_by)
    values
      (${entryId}, ${fx.orgId}, ${fx.bookId}, ${opts.sub},
       ${`SCOPE-${opts.tag}-${entryId.slice(0, 8)}`}, ${fx.date}, ${fx.periodId},
       ${`Subsidiary scope ${opts.tag}`}, 'draft', 'manual', ${fx.actor}, ${fx.actor})
  `);
  await db.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, subsidiary_id,
       amount, currency, txn_amount, fx_rate, memo)
    values
      (${bankLineId}, ${fx.orgId}, ${entryId}, 1, ${opts.account}, ${opts.sub},
       ${opts.amount}, 'CAD', ${opts.amount}, 1, ${opts.tag}),
      (${randomUUID()}, ${fx.orgId}, ${entryId}, 2, ${fx.offset}, ${opts.sub},
       ${offsetAmount}, 'CAD', ${offsetAmount}, 1, ${opts.tag})
  `);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_by = ${fx.actor}, updated_by = ${fx.actor}
     where id = ${entryId} and org_id = ${fx.orgId}
  `);
  return bankLineId;
}

async function importLines(
  fx: TwoEntity,
  account: string,
  tag: string,
  amounts: readonly string[],
  scope: ReadonlySet<string> | null,
): Promise<{ statementId: string | null; lineIds: string[] }> {
  const nonce = randomUUID().slice(0, 8);
  const result = await importStatement(
    {
      accountId: account,
      source: "ofx",
      statementDate: fx.date,
      openingBalance: "0",
      closingBalance: String(amounts.reduce((sum, a) => sum + Number(a), 0)),
      currency: "CAD",
      lines: amounts.map((amount, i) => ({
        postedOn: fx.date,
        amount,
        description: `${tag} ${i}`,
        bankTransactionId: `${tag}-${nonce}-${i}`,
      })),
    },
    { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scope }
  );
  const rows = (await db.execute<{ id: string }>(sql`
    select id from bank_statement_lines
     where org_id = ${fx.orgId} and account_id = ${account}
     order by line_number
  `));
  return { statementId: result.statementId, lineIds: rows.rows.map((r) => r.id) };
}

async function countReconciliations(fx: TwoEntity): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from reconciliations where org_id = ${fx.orgId}
  `)).rows[0]!.n;
}

async function matchStatus(fx: TwoEntity, lineId: string): Promise<string> {
  return (await db.execute<{ s: string }>(sql`
    select match_status as s from bank_statement_lines where id = ${lineId} and org_id = ${fx.orgId}
  `)).rows[0]!.s;
}

function scopeOf(fx: TwoEntity, sub: "A" | "B"): ReadonlySet<string> {
  return new Set(sub === "A" ? [fx.subA] : [fx.subB]);
}

const OPEN: ReadonlySet<string> | null = null;

async function assertNotFound(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    // Canonical uniform not-found: bare "not found" at 404, whether the row
    // is missing or sits outside the caller's subsidiary scope.
    if (!(error instanceof ScopeNotFoundError)) return false;
    return error.status === 404 && error.message === "not found";
  });
}

test("start refuses an out-of-scope bank account and writes nothing", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    await assertNotFound(
      startReconciliation(
        { accountId: fx.bankA, throughDate: fx.date, statementBalance: "0" },
        { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "B") },
      )
    );
    assert.equal(await countReconciliations(fx), 0);
    // A shared account is reconcilable only with unrestricted scope.
    await assertNotFound(
      startReconciliation(
        { accountId: fx.bankShared, throughDate: fx.date, statementBalance: "0" },
        { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") },
      )
    );
    assert.equal(await countReconciliations(fx), 0);
    // In-scope callers proceed on both models.
    const owned = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: "0" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") }
    );
    assert.ok(owned.id);
    const shared = await startReconciliation(
      { accountId: fx.bankShared, throughDate: fx.date, statementBalance: "0" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: OPEN }
    );
    assert.ok(shared.id);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("import and reconciliation recheck account scope after a concurrent rehome", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  const { Client } = await import("pg");
  const scope = new Set([fx.subA]);
  const ctx = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scope };
  const holder: Client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  await holder.connect();
  try {
    for (const action of ["import", "reconciliation"] as const) {
      await db.execute(sql`update accounts set subsidiary_id=${fx.subA} where id=${fx.bankA} and org_id=${fx.orgId}`);
      await holder.query("begin");
      await holder.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)", [fx.orgId]);
      const fence = action === "import" ? `bank-statement-import:${fx.orgId}:${fx.bankA}` : `bank-reconciliation:${fx.orgId}:${fx.bankA}`;
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [fence]);
      await holder.query("update accounts set subsidiary_id=$1 where id=$2 and org_id=$3", [fx.subB, fx.bankA, fx.orgId]);
      const pending = action === "import"
        ? importStatement({ accountId: fx.bankA, source: "manual", currency: "CAD", statementDate: fx.date,
            lines: [{ postedOn: fx.date, amount: "1", description: "Rehome race" }] }, ctx)
        : startReconciliation({ accountId: fx.bankA, throughDate: fx.date, statementBalance: "0" }, ctx);
      let settled = false;
      let settledError: unknown;
      void pending.then(() => { settled = true; }, (error) => { settledError = error; settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, false, `${action} must reach the account advisory fence after its scope preflight: ${String(settledError)}`);
      await holder.query("commit");
      await assert.rejects(pending, /not found/i, `${action} must refuse after the account moves out of caller scope`);
    }
  } finally {
    await holder.query("rollback").catch(() => undefined);
    await holder.end();
    await dropScratchOrg(fx.orgId);
  }
});

test("import refuses an out-of-scope bank account and writes nothing", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    await assertNotFound(
      importLines(fx, fx.bankB, "scope-import-b", ["10"], scopeOf(fx, "A"))
    );
    const lines = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from bank_statement_lines where org_id = ${fx.orgId}
    `)).rows[0]!.n;
    assert.equal(lines, 0);
    const ok = await importLines(fx, fx.bankB, "scope-import-b", ["10"], scopeOf(fx, "B"));
    assert.ok(ok.statementId);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("session verbs refuse an out-of-scope session with uniform not-found", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const journalA = await postBankLine(fx, { account: fx.bankA, sub: fx.subA, amount: "100", tag: "a100" });
    const { lineIds } = await importLines(fx, fx.bankA, "scope-session", ["100"], OPEN);
    const session = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: "100" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") }
    );
    const out = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "B") };
    await assertNotFound(reconciliationTotals(session.id, out));
    await assertNotFound(
      createMatch(
        { reconciliationId: session.id, statementLineId: lineIds[0]!, journalLineIds: [journalA] },
        out,
      )
    );
    await assertNotFound(autoMatch(session.id, out));
    await assertNotFound(
      adjustReconciliation(session.id, { statementBalance: "100" }, out)
    );
    await assertNotFound(discardReconciliation(session.id, out));
    await assertNotFound(markReconciled(session.id, out));
    // Nothing was written or released by the refusals.
    assert.equal(await countReconciliations(fx), 1);
    assert.equal(await matchStatus(fx, lineIds[0]!), "unmatched");
    // The in-scope caller still owns the session end to end.
    const totals = await createMatch(
      { reconciliationId: session.id, statementLineId: lineIds[0]!, journalLineIds: [journalA] },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") }
    );
    assert.equal(totals.difference, "0.0000");
    const signed = await markReconciled(session.id, {
      orgId: fx.orgId,
      userId: fx.actor,
      allowedSubsidiaryIds: scopeOf(fx, "A"),
    });
    assert.equal(signed.journalLinesReconciled, 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("unmatch and discard refuse across the boundary without touching rows", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const journalA = await postBankLine(fx, { account: fx.bankA, sub: fx.subA, amount: "40", tag: "a40" });
    const { lineIds } = await importLines(fx, fx.bankA, "scope-unmatch", ["40"], OPEN);
    const session = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: "40" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") }
    );
    const inScope = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") };
    const out = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "B") };
    await createMatch(
      { reconciliationId: session.id, statementLineId: lineIds[0]!, journalLineIds: [journalA] },
      inScope
    );
    assert.equal(await matchStatus(fx, lineIds[0]!), "matched");
    await assertNotFound(
      unmatchStatementLine({ reconciliationId: session.id, statementLineId: lineIds[0]! }, out)
    );
    assert.equal(await matchStatus(fx, lineIds[0]!), "matched");
    await unmatchStatementLine({ reconciliationId: session.id, statementLineId: lineIds[0]! }, inScope);
    assert.equal(await matchStatus(fx, lineIds[0]!), "unmatched");
    await assertNotFound(discardReconciliation(session.id, out));
    assert.equal(await countReconciliations(fx), 1);
    await discardReconciliation(session.id, inScope);
    assert.equal(await countReconciliations(fx), 0);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("manual match cannot claim another entity's journal line", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const journalB = await postBankLine(fx, { account: fx.bankA, sub: fx.subB, amount: "25", tag: "b25" });
    const journalA = await postBankLine(fx, { account: fx.bankA, sub: fx.subA, amount: "25", tag: "a25" });
    const { lineIds } = await importLines(fx, fx.bankA, "scope-claim", ["25"], OPEN);
    const session = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: "25" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") }
    );
    const inScope = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") };
    // The foreign line reads as unavailable — never as another entity's row.
    await assert.rejects(
      createMatch(
        { reconciliationId: session.id, statementLineId: lineIds[0]!, journalLineIds: [journalB] },
        inScope,
      )
    );
    assert.equal(await matchStatus(fx, lineIds[0]!), "unmatched");
    const totals = await createMatch(
      { reconciliationId: session.id, statementLineId: lineIds[0]!, journalLineIds: [journalA] },
      inScope
    );
    assert.equal(totals.difference, "0.0000");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("auto-match never claims out-of-scope journal lines", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    await postBankLine(fx, { account: fx.bankA, sub: fx.subB, amount: "50", tag: "b50" });
    await importLines(fx, fx.bankA, "scope-auto", ["50"], OPEN);
    const session = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: "50" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") }
    );
    const scoped = await autoMatch(session.id, {
      orgId: fx.orgId,
      userId: fx.actor,
      allowedSubsidiaryIds: scopeOf(fx, "A"),
    });
    assert.equal(scoped.matched, 0);
    // The line was matchable — only the scope filter held it back.
    const open = await autoMatch(session.id, { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: OPEN });
    assert.equal(open.matched, 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("sign-off refuses a session holding out-of-scope matches", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const journalB = await postBankLine(fx, { account: fx.bankA, sub: fx.subB, amount: "70", tag: "b70" });
    const { lineIds } = await importLines(fx, fx.bankA, "scope-signoff", ["70"], OPEN);
    const session = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: "70" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: OPEN }
    );
    await createMatch(
      { reconciliationId: session.id, statementLineId: lineIds[0]!, journalLineIds: [journalB] },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: OPEN }
    );
    // A restricted caller cannot attest to lines they cannot see.
    await assert.rejects(
      markReconciled(session.id, {
        orgId: fx.orgId,
        userId: fx.actor,
        allowedSubsidiaryIds: scopeOf(fx, "A"),
      })
    );
    const status = (await db.execute<{ s: string }>(sql`
      select status as s from reconciliations where id = ${session.id} and org_id = ${fx.orgId}
    `)).rows[0]!.s;
    assert.notEqual(status, "signed_off");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("exclude and restore refuse out-of-scope statement lines", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const { lineIds } = await importLines(fx, fx.bankB, "scope-exclude", ["15"], OPEN);
    const lineId = lineIds[0]!;
    const out = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") };
    const inScope = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "B") };
    await assertNotFound(
      excludeStatementLine(lineId, "a sufficient reason", out)
    );
    assert.equal(await matchStatus(fx, lineId), "unmatched");
    await excludeStatementLine(lineId, "a sufficient reason", inScope);
    assert.equal(await matchStatus(fx, lineId), "excluded");
    await assertNotFound(restoreStatementLine(lineId, out));
    assert.equal(await matchStatus(fx, lineId), "excluded");
    await restoreStatementLine(lineId, inScope);
    assert.equal(await matchStatus(fx, lineId), "unmatched");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("duplicate-flag verbs refuse out-of-scope lines without reading flags", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const { lineIds } = await importLines(fx, fx.bankB, "scope-dupe", ["15"], OPEN);
    const lineId = lineIds[0]!;
    const out = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "A") };
    // The gate fires before the flag check, so no flagged fixture is needed.
    await assertNotFound(clearPossibleDuplicateFlag(lineId, out));
    await assertNotFound(
      excludePossibleDuplicates(fx.bankB, "a sufficient reason", out),
    );
    assert.equal(await matchStatus(fx, lineId), "unmatched");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("adjust of a missing session still returns null", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const missing = await adjustReconciliation(
      randomUUID(),
      { statementBalance: "1" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: OPEN }
    );
    assert.equal(missing, null);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("unrestricted callers keep full access on shared accounts", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const ctx = { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: OPEN };
    const journal = await postBankLine(fx, { account: fx.bankShared, sub: fx.subA, amount: "90", tag: "s90" });
    const { lineIds } = await importLines(fx, fx.bankShared, "scope-shared", ["90"], OPEN);
    const session = await startReconciliation(
      { accountId: fx.bankShared, throughDate: fx.date, statementBalance: "90" },
      ctx
    );
    const totals = await createMatch(
      { reconciliationId: session.id, statementLineId: lineIds[0]!, journalLineIds: [journal] },
      ctx
    );
    assert.equal(totals.difference, "0.0000");
    // An explicit null scope is unrestricted too.
    const read = await reconciliationTotals(session.id, { ...ctx, allowedSubsidiaryIds: null });
    assert.equal(read.difference, "0.0000");
    const signed = await markReconciled(session.id, ctx);
    assert.equal(signed.journalLinesReconciled, 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("scope denials are the canonical uniform not-found", { skip: !DB }, async () => {
  const fx = await seedTwoEntity();
  try {
    const failure = await startReconciliation(
      { accountId: fx.bankA, throughDate: fx.date, statementBalance: "0" },
      { orgId: fx.orgId, userId: fx.actor, allowedSubsidiaryIds: scopeOf(fx, "B") },
    ).then(
      () => null,
      (error: unknown) => error
    );
    // The canonical module's denial, which bankingErrorResponse maps to a
    // 404 with the bare "not found" body — identical to a missing account.
    assert.ok(failure instanceof ScopeNotFoundError);
    assert.equal((failure as ScopeNotFoundError).status, 404);
    assert.equal((failure as ScopeNotFoundError).message, "not found");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
