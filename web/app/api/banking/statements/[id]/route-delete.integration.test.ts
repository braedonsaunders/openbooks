import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

/**
 * QA-154: DELETE /api/banking/statements/<id> on a statement tied to an
 * in-progress reconciliation (lines matched in an unsigned session) must
 * refuse typed — 422 with the unmatch remedy — never a 500. Authorization
 * is the only mocked dependency; the handler, engine and database run for
 * real, so a raw FK/constraint throw would surface here as 500 or "threw".
 */
const stateKey = Symbol.for("openbooks.statement-delete-route-test");
interface Gate {
  user: { orgId: string; id: string };
  allowedSubsidiaryIds: null;
}
const routeState = { gate: null as Gate | null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuth = `const state = globalThis[Symbol.for('openbooks.statement-delete-route-test')]
export async function guardFeaturePermission() { return state.gate }
export async function guardPermission() { return state.gate }
export async function getAuthz() { return state.gate }`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/feature-gates" || specifier === "@/lib/authz") {
      return { url: "mock:banking-auth", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:banking-auth") {
      return { format: "module", source: mockAuth, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?statement-delete-route-test";
const { DELETE } = (await import(routeUrl)) as typeof import("./route.ts");

const { db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;
const { createMatch, importStatement, startReconciliation } =
  await import("@openbooks/engine/banking/banking");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function postBankLine(
  org: ScratchOrg,
  actorId: string,
  bankAmount: string,
  label: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`QADEL-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`QA delete ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
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
  const ctx = {
    orgId: org.orgId,
    userId: actor,
    allowedSubsidiaryIds: null,
  };
  routeState.gate = { user: { orgId: org.orgId, id: actor }, allowedSubsidiaryIds: null };
  return { org, actor, ctx };
}

function importCsv(
  input: Omit<Parameters<typeof importStatement>[0], "source" | "sourceEvidence"> & {
    source: "csv";
  },
  ctx: Parameters<typeof importStatement>[1],
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
      sourceEvidence: {
        content,
        filename: "statement.csv",
        contentType: "text/csv",
        csvMapping: { date: 0, amount: 1, description: 2, bankTransactionId: 3 },
      },
    },
    ctx,
  );
}

async function deleteStatus(
  statementId: string,
): Promise<{ status: number | "threw"; body: unknown }> {
  try {
    const res = (await DELETE(
      new Request(`http://openbooks.test/api/banking/statements/${statementId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: statementId }) },
    )) as Response;
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: "threw", body: null };
  }
}

test(
  "DELETE refuses a statement matched in an unsigned session with 422, never 500",
  { skip: !DB },
  async () => {
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
              bankTransactionId: "r1",
            },
          ],
        },
        ctx,
      );
      const [lineId] = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `,
          "objects",
        )
      ).map((row) => row.id);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [lineId!], journalLineIds: [journal!] },
        ctx,
      );
      const outcome = await deleteStatus(imported.statementId!);
      assert.equal(
        outcome.status,
        422,
        `matched-open delete must refuse typed, got ${outcome.status}`,
      );
      assert.match(
        String((outcome.body as { error?: string } | null)?.error ?? ""),
        /unmatch them first/,
        "the refusal names its remedy",
      );
      const survivors = (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n from bank_statement_lines
         where statement_id = ${imported.statementId!} and org_id = ${org.orgId}
      `,
          "objects",
        )
      )[0]!.n;
      assert.equal(survivors, 1, "the refused delete leaves every line untouched");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("DELETE removes an untouched import with 200", { skip: !DB }, async () => {
  const { org, ctx } = await setup();
  try {
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
            bankTransactionId: "r1",
          },
        ],
      },
      ctx,
    );
    const outcome = await deleteStatus(imported.statementId!);
    assert.equal(outcome.status, 200, `clean delete must succeed, got ${outcome.status}`);
    assert.equal((outcome.body as { deletedLines?: number } | null)?.deletedLines, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
