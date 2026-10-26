import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withMaintenanceTransaction,
  withOrgContext,
} from "../platform/db.ts";
import {
  assertDedicatedFixtureDatabase,
  assertFixtureDatabase,
  createScratchOrg,
  dropScratchOrg,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { postEntry } from "../journal/post-entry.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "native typed residual insertion and registered historical copy preserve both authoritative FX overloads",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const entryId = await withOrgContext(org.orgId, async () => {
        for (const [entryNumber, amount, txnAmount, fxRate, offset] of [
          ["FX-OPEN", "12", "10", "1.2", "-12"],
          ["FX-SETTLE", "-13", "-10", "1.3", "13"],
        ])
          await postEntry(db, {
            orgId: org.orgId,
            bookId: org.bookId,
            subsidiaryId: org.subsidiaryId,
            entryNumber: entryNumber!,
            postingDate: org.date,
            periodId: org.periodId,
            origin: "manual",
            lines: [
              {
                accountId: org.accounts.bank,
                amount: amount!,
                currency: "USD",
                txnAmount: txnAmount!,
                fxRate: fxRate!,
              },
              { accountId: org.accounts.fxGainLoss, amount: offset!, currency: "CAD" },
            ],
          });
        const documentId = randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,fx_rate,journal_mode,subtotal,total)
        values(${documentId},${org.orgId},'journal','draft','FX-RESIDUAL',${org.subsidiaryId},${org.date},'CAD',1,'currency_adjustment',1,1)`);
        const result = await postEntry(db, {
          orgId: org.orgId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          entryNumber: "FX-RESIDUAL",
          postingDate: org.date,
          periodId: org.periodId,
          origin: "currency_adjustment",
          sourceDocumentId: documentId,
          lines: [
            {
              accountId: org.accounts.bank,
              amount: "1",
              currency: "USD",
              txnAmount: "0",
              fxRate: "1",
              isCurrencyAdjustment: true,
            },
            { accountId: org.accounts.fxGainLoss, amount: "-1", currency: "CAD" },
          ],
        });
        const selectors = [
          ...Array.from({ length: 128 }, () => result.entryId),
          randomUUID(),
          null,
        ];
        for (const posting of [true, false]) {
          await db.execute(
            sql`select public.journal_lines_check_fx_residual_entries(${sql.param(selectors)}::uuid[],${posting})`,
          );
        }
        await db.execute(
          sql`select public.journal_lines_check_fx_residual_entries(${sql.param(selectors)}::uuid[])`,
        );
        return result.entryId;
      });
      // The destination headers are already posted when their lines are copied:
      // this INSERT executes the statement trigger's authoritative two-argument guard.
      sandbox = await withBypassContext(() =>
        createSandbox({
          productionOrgId: org.orgId,
          name: "Scratch typed FX history",
          tier: "full",
          masked: false,
        }),
      );
      const rows = await db.execute<{ amount: string; txn: string; tagged: boolean }>(
        sql`select l.amount::text,l.txn_amount::text as txn,l.is_currency_adjustment as tagged
      from journal_lines l join orgs o on o.id=l.org_id where l.org_id=${sandbox.sandboxOrgId}
        and l.entry_id=ob_rebase(${entryId}::uuid,o.sandbox_seed) order by l.line_number`,
        "objects",
      );
      assert.deepEqual(rows, [
        { amount: "1.0000", txn: "0.0000", tagged: true },
        { amount: "-1.0000", txn: "-1.0000", tagged: false },
      ]);
      await deleteSandbox(sandbox.sandboxId);
      sandbox = undefined;
    } finally {
      if (sandbox) await dropScratchOrgReporting(sandbox.sandboxOrgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a typed flag cannot exempt ordinary nonzero foreign exposure", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await assert.rejects(
      () =>
        withOrgContext(org.orgId, () =>
          postEntry(db, {
            orgId: org.orgId,
            bookId: org.bookId,
            subsidiaryId: org.subsidiaryId,
            entryNumber: "FORGED-RESIDUAL",
            postingDate: org.date,
            periodId: org.periodId,
            origin: "manual",
            lines: [
              {
                accountId: org.accounts.bank,
                amount: "1",
                currency: "USD",
                txnAmount: "1",
                fxRate: "1",
                isCurrencyAdjustment: true,
              },
              { accountId: org.accounts.fxGainLoss, amount: "-1", currency: "CAD" },
            ],
          }),
        ),
      (error) =>
        errorChainMatches(
          error,
          /Typed currency adjustments carry only a base amount and zero foreign transaction value/,
        ),
    );
    assert.equal(
      (
        await db.execute<{ count: number }>(
          sql`select count(*)::int from journal_entries where org_id=${org.orgId}`,
          "objects",
        )
      )[0]?.count,
      0,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "ordinary FX excess retains bounded membership, repeated selectors and distinct posting/history refusals",
  { skip: !DB },
  async () => {
    await assertDedicatedFixtureDatabase();
    await assertFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const posted = await withOrgContext(org.orgId, () =>
        postEntry(db, {
          orgId: org.orgId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          entryNumber: "ORDINARY-FX",
          postingDate: org.date,
          periodId: org.periodId,
          origin: "manual",
          lines: [
            {
              accountId: org.accounts.bank,
              amount: "10",
              txnAmount: "10",
              currency: "CAD",
              fxRate: "1",
            },
            {
              accountId: org.accounts.cogs,
              amount: "-10",
              txnAmount: "-10",
              currency: "CAD",
              fxRate: "1",
            },
          ],
        }),
      );
      const before = await db.execute(
        sql`select * from journal_lines where org_id=${org.orgId} and entry_id=${posted.entryId} order by line_number`,
        "objects",
      );
      const rollback = new Error("rollback disposable historical anomaly");
      await assert.rejects(
        () =>
          withMaintenanceTransaction(null, async () => {
            // A legacy anomaly is constructed only in a marked, dedicated fixture database.
            // The outer rollback restores the rows and these exact guards together.
            await db.execute(sql`alter table public.journal_lines disable trigger jl_guard`);
            await db.execute(
              sql`alter table public.journal_lines disable trigger journal_lines_fx_residual_stmt_upd`,
            );
            await db.execute(sql`update journal_lines set amount=case when line_number=1 then 10.0003 else -10.0003 end,
        txn_amount=case when line_number=1 then 10 else -10.0003 end where org_id=${org.orgId} and entry_id=${posted.entryId}`);
            const unrelated = [randomUUID(), null];
            await db.execute(
              sql`select public.journal_lines_check_fx_residual_entries(${sql.param(unrelated)}::uuid[],true)`,
            );
            await db.execute(
              sql`select public.journal_lines_check_fx_residual_entries(array[]::uuid[],false)`,
            );
            for (const repeated of [false, true])
              for (const posting of [true, false]) {
                const selectors = repeated
                  ? [...Array.from({ length: 128 }, () => posted.entryId), ...unrelated]
                  : [posted.entryId];
                await db.execute(sql`savepoint expected_fx_refusal`);
                let refusal: unknown;
                try {
                  await db.execute(
                    sql`select public.journal_lines_check_fx_residual_entries(${sql.param(selectors)}::uuid[],${posting})`,
                  );
                } catch (error) {
                  refusal = error;
                }
                await db.execute(sql`rollback to savepoint expected_fx_refusal`);
                await db.execute(sql`release savepoint expected_fx_refusal`);
                assert.ok(
                  errorChainMatches(
                    refusal,
                    posting
                      ? /nothing was posted; correct the line exchange rates/
                      : /posted lines cannot be amended; correct through the ledger API/,
                  ),
                );
                assert.ok(errorChainMatches(refusal, new RegExp(posted.entryId)));
                assert.ok(
                  errorChainMatches(
                    refusal,
                    repeated
                      ? /stored deviation 0\.0384 over 256 lines/
                      : /stored deviation 0\.0003 over 2 lines/,
                  ),
                );
              }
            await db.execute(sql`savepoint expected_wrapper_refusal`);
            let wrapperRefusal: unknown;
            try {
              await db.execute(
                sql`select public.journal_lines_check_fx_residual_entries(array[${posted.entryId}::uuid])`,
              );
            } catch (error) {
              wrapperRefusal = error;
            }
            await db.execute(sql`rollback to savepoint expected_wrapper_refusal`);
            await db.execute(sql`release savepoint expected_wrapper_refusal`);
            assert.ok(errorChainMatches(wrapperRefusal, /posted lines cannot be amended/));
            throw rollback;
          }),
        (error) => error === rollback,
      );
      const after = await db.execute(
        sql`select * from journal_lines where org_id=${org.orgId} and entry_id=${posted.entryId} order by line_number`,
        "objects",
      );
      assert.deepEqual(after, before);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
