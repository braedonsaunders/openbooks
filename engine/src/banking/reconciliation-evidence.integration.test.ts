import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  adjustReconciliation,
  createMatch,
  excludeStatementLine,
  importStatement,
  markReconciled,
  reconciliationEvidence,
  startReconciliation,
  withdrawReconciliationSignOff,
} from "./banking.ts";
import { db } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Ctx = { orgId: string; userId: string; allowedSubsidiaryIds: ReadonlySet<string> | null };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  amount: string,
  date: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`EVD-${entryId.slice(0, 8)}`}, ${date},
              ${org.periodId}, 'Deposit', 'draft', 'manual', ${actorId}, ${actorId})`);
    const offset = amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
    const [bankLine] = await tx.execute<{ id: string }>(
      sql`
      insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1, 'deposit'),
             (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${org.subsidiaryId}, ${offset}, 'CAD', ${offset}, 1, 'deposit')
      returning id`,
      "objects",
    );
    await tx.execute(sql`
      update journal_entries set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}`);
    return bankLine!.id;
  });
}

/** One statement import with its own bytes, so same-date imports stay separate statements. */
async function importLines(
  org: ScratchOrg,
  ctx: Ctx,
  tag: string,
  lines: { id: string; amount: string; description: string }[],
): Promise<string> {
  const content = `date,amount,description,bank_transaction_id\n${lines.map((line) => `${org.date},${line.amount},"${line.description.replaceAll('"', '""')}",${line.id}`).join("\n")}\n`;
  const imported = await importStatement(
    {
      accountId: org.accounts.bank,
      source: "csv",
      statementDate: org.date,
      currency: "CAD",
      lines: lines.map((line) => ({
        postedOn: org.date,
        amount: line.amount,
        description: line.description,
        bankTransactionId: line.id,
      })),
      sourceEvidence: {
        content,
        filename: `${tag}.csv`,
        contentType: "text/csv",
        csvMapping: { date: 0, amount: 1, description: 2, bankTransactionId: 3 },
      },
    },
    ctx,
  );
  assert.ok(imported.statementId, `statement ${tag} imports`);
  return imported.statementId;
}

async function statementLineIds(statementId: string): Promise<string[]> {
  return (
    await db.execute<{ id: string }>(
      sql`
    select id from bank_statement_lines where statement_id = ${statementId} order by line_number`,
      "objects",
    )
  ).map((row) => row.id);
}

async function userName(orgId: string, userId: string): Promise<string | null> {
  const row = (
    await db.execute<{ name: string | null }>(
      sql`
    select name from users where id = ${userId} and org_id = ${orgId}`,
      "objects",
    )
  )[0];
  return row?.name ?? null;
}

async function signedSession(org: ScratchOrg, ctx: Ctx, actor: string): Promise<string> {
  const journal = await postBankJournal(org, actor, "250.00", org.date);
  const statementId = await importLines(org, ctx, "signed", [
    { id: "signed-deposit", amount: "250.00", description: "Deposit" },
  ]);
  const [line] = await statementLineIds(statementId);
  const recon = await startReconciliation(
    { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "250.00" },
    ctx,
  );
  await createMatch(
    { reconciliationId: recon.id, statementLineIds: [line!], journalLineIds: [journal] },
    ctx,
  );
  await markReconciled(recon.id, ctx);
  return recon.id;
}

async function prepareAccount(org: ScratchOrg): Promise<void> {
  await db.execute(sql`
    update accounts set reconcilable = true, currency_restriction = 'CAD', subsidiary_id = ${org.subsidiaryId}
     where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
}

test(
  "every statement with the same date is listed, with its excluded lines and their reasons",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await prepareAccount(org);
      const ctx: Ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };

      const original = await importLines(org, ctx, "original", [
        { id: "orig-1", amount: "100.00", description: "Client A" },
        { id: "orig-2", amount: "-20.00", description: "Supplies" },
        { id: "orig-3", amount: "35.00", description: "Client B" },
      ]);
      const supplemental = await importLines(org, ctx, "supplemental", [
        { id: "late-1", amount: "60.00", description: "Client C" },
        { id: "late-2", amount: "-5.00", description: "Bank fee" },
      ]);
      const reimport = await importLines(org, ctx, "reimport", [
        { id: "dup-1", amount: "-5.00", description: "Bank fee" },
      ]);
      const [duplicateLine] = await statementLineIds(reimport);
      const reason = "Duplicate of the bank fee on the supplemental statement";
      await excludeStatementLine(duplicateLine!, reason, ctx);

      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "0.00" },
        ctx,
      );
      const evidence = await reconciliationEvidence(recon.id, ctx);

      assert.equal(
        evidence.reconciliation.windowStart,
        null,
        "with no signed session the window opens at the first line",
      );
      assert.deepEqual(
        evidence.statements.map((statement) => statement.id).sort(),
        [original, supplemental, reimport].sort(),
        "all three same-date statements support the session",
      );
      const byId = new Map(evidence.statements.map((statement) => [statement.id, statement]));
      assert.equal(byId.get(original)!.windowLines, 3);
      assert.equal(byId.get(original)!.unmatchedLines, 3);
      assert.equal(byId.get(original)!.windowTotal, "115.0000");
      assert.equal(byId.get(supplemental)!.windowLines, 2);
      assert.equal(byId.get(reimport)!.excludedLines, 1);
      assert.equal(byId.get(reimport)!.windowTotal, "-5.0000");

      assert.equal(evidence.excludedLines.length, 1);
      const [excluded] = evidence.excludedLines;
      assert.equal(excluded!.id, duplicateLine);
      assert.equal(excluded!.statementId, reimport);
      assert.equal(excluded!.amount, "-5.0000");
      assert.equal(excluded!.exclusionReason, reason);
      assert.equal(excluded!.excludedByName, await userName(org.orgId, actor));
      assert.match(excluded!.excludedAt ?? "", ISO_INSTANT);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the history keeps a sign-off, its withdrawal with the prior balance and reason, and the re-sign",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await prepareAccount(org);
      const ctx: Ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      const reconId = await signedSession(org, ctx, actor);

      await withdrawReconciliationSignOff(reconId, "Late deposit belongs in this period", ctx);
      await markReconciled(reconId, ctx);

      const evidence = await reconciliationEvidence(reconId, ctx);
      assert.deepEqual(
        evidence.history.map((event) => event.kind),
        ["sign_off", "withdraw_sign_off", "sign_off"],
      );
      const name = await userName(org.orgId, actor);
      const [signed, withdrawn, resigned] = evidence.history;

      assert.ok(signed?.kind === "sign_off");
      assert.equal(signed.statementBalance, "250.0000");
      assert.equal(signed.actorName, name);
      assert.match(signed.at, ISO_INSTANT);

      assert.ok(withdrawn?.kind === "withdraw_sign_off");
      assert.equal(withdrawn.reason, "Late deposit belongs in this period");
      assert.equal(withdrawn.priorStatementBalance, "250.0000");
      assert.equal(withdrawn.priorSignedOffByName, name);
      assert.match(withdrawn.priorSignedOffAt ?? "", ISO_INSTANT);
      assert.equal(withdrawn.actorName, name);

      assert.ok(resigned?.kind === "sign_off");
      assert.equal(resigned.statementBalance, "250.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a session adjustment is listed with the balance and through date before and after it",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await prepareAccount(org);
      const ctx: Ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      await importLines(org, ctx, "adjust", [
        { id: "adjust-1", amount: "10.00", description: "Interest" },
      ]);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "250.00" },
        ctx,
      );
      await adjustReconciliation(recon.id, { statementBalance: "260.00" }, ctx);

      const evidence = await reconciliationEvidence(recon.id, ctx);
      assert.equal(evidence.history.length, 1);
      const [adjustment] = evidence.history;
      assert.ok(adjustment?.kind === "session_adjustment");
      assert.equal(adjustment.before?.statementBalance, "250.0000");
      assert.equal(adjustment.before?.throughDate, org.date);
      assert.equal(adjustment.after?.statementBalance, "260.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an out-of-scope caller is refused with the uniform not-found and reads nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await prepareAccount(org);
      const ctx: Ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      await importLines(org, ctx, "scope", [
        { id: "scope-1", amount: "10.00", description: "Interest" },
      ]);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "10.00" },
        ctx,
      );

      const outOfScope: Ctx = {
        orgId: org.orgId,
        userId: actor,
        allowedSubsidiaryIds: new Set([randomUUID()]),
      };
      await assert.rejects(reconciliationEvidence(recon.id, outOfScope), ScopeNotFoundError);
      await assert.rejects(
        reconciliationEvidence(randomUUID(), ctx),
        ScopeNotFoundError,
        "a missing session refuses identically",
      );

      const inScope: Ctx = {
        orgId: org.orgId,
        userId: actor,
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      };
      const evidence = await reconciliationEvidence(recon.id, inScope);
      assert.equal(evidence.statements.length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
