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
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { postEntry } from "../journal/post-entry.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

for (const masked of [false, true]) {
  test(
    `a ${masked ? "masked" : "full"} sandbox retains historical zero-foreign residuals, named rate policies and omits executable reversals`,
    { skip: !DB },
    async () => {
      const source = await createScratchOrg();
      let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
      try {
        const actor = await createScratchUser(
          source.orgId,
          "Financial controller",
          "financial_controller",
        );
        await db.execute(
          sql`update app_roles set permissions='["gl.post","gl.read"]'::jsonb where org_id=${source.orgId} and key='financial_controller'`,
        );
        await withOrgContext(source.orgId, async () => {
          await db.execute(
            sql`update orgs set settings=jsonb_set(settings,'{features,multiCurrency}','true'::jsonb) where id=${source.orgId}`,
          );
          await db.execute(
            sql`insert into fx_rate_types(org_id,key,name,created_by,updated_by) values(${source.orgId},'corporate','Corporate treasury',${actor},${actor})`,
          );
          await db.execute(sql`insert into subsidiary_accounting_preferences(org_id,subsidiary_id,effective_from,posting_rate_type,reason,created_by,updated_by)
          values(${source.orgId},${source.subsidiaryId},${source.date},'corporate','Approved treasury series',${actor},${actor})`);
          for (const [entryNumber, txnAmount, fxRate, amount, offset] of [
            ["EXPOSURE", "10", "1.2", "12", "-12"],
            ["SETTLEMENT", "-10", "1.3", "-13", "13"],
          ])
            await postEntry(db, {
              orgId: source.orgId,
              bookId: source.bookId,
              subsidiaryId: source.subsidiaryId,
              entryNumber: entryNumber!,
              postingDate: source.date,
              periodId: source.periodId,
              origin: "manual",
              lines: [
                {
                  accountId: source.accounts.bank,
                  currency: "USD",
                  txnAmount: txnAmount!,
                  fxRate: fxRate!,
                  amount: amount!,
                  ...(entryNumber === "EXPOSURE"
                    ? {
                        custom: {
                          equitySecurityId: "z".repeat(36),
                          equityRole: "malformed_snapshot",
                        },
                      }
                    : {}),
                },
                { accountId: source.accounts.fxGainLoss, currency: "CAD", amount: offset! },
              ],
            });
          const documentId = randomUUID();
          await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,fx_rate,journal_mode,journal_reverse_on,subtotal,total,created_by)
          values(${documentId},${source.orgId},'journal','draft','RESIDUAL',${source.subsidiaryId},${source.date},'CAD',1,'currency_adjustment','2026-08-01',1,1,${actor})`);
          await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,amount,quantity,unit_price,journal_currency)
          values(${source.orgId},${documentId},1,${source.accounts.bank},1,1,1,'USD'),(${source.orgId},${documentId},2,${source.accounts.fxGainLoss},-1,1,-1,null)`);
          await db.execute(
            sql`update documents set status='approved',updated_by=${actor} where org_id=${source.orgId} and id=${documentId}`,
          );
          await postDocument(
            documentId,
            {
              control: {
                ar: source.accounts.ar,
                ap: source.accounts.ap,
                bank: source.accounts.bank,
              },
            },
            { audit: { actorId: actor, source: "ui" } },
          );
        });
        sandbox = await withBypassContext(() =>
          createSandbox({
            productionOrgId: source.orgId,
            name: "Scratch financial history",
            tier: masked ? "masked" : "full",
            masked,
          }),
        );
        const target = sandbox.sandboxOrgId;
        const projection = async () =>
          await db.execute<{
            amount: string;
            txn: string;
            currency: string;
            tagged: boolean;
            residual: string;
          }>(
            sql`
        select l.amount::text,l.txn_amount::text as txn,l.currency,l.is_currency_adjustment as tagged,
          (select sum(all_lines.amount)::text from journal_lines all_lines where all_lines.org_id=l.org_id and all_lines.account_id=l.account_id) as residual
        from journal_lines l where l.org_id=${target} and l.is_currency_adjustment`,
            "objects",
          );
        assert.deepEqual(await projection(), [
          { amount: "1.0000", txn: "0.0000", currency: "USD", tagged: true, residual: "0.0000" },
        ]);
        if (!masked) {
          assert.equal(
            (
              await db.execute<{ securityId: string }>(
                sql`
          select custom->>'equitySecurityId' as "securityId" from journal_lines
           where org_id=${target} and custom->>'equityRole'='malformed_snapshot'`,
                "objects",
              )
            )[0]?.securityId,
            "z".repeat(36),
          );
        }
        const registry = await db.execute<{ key: string }>(
          sql`select key from fx_rate_types where org_id=${target} order by key`,
          "objects",
        );
        assert.deepEqual(
          registry.map((row) => row.key),
          ["average", "corporate", "historical", "spot"],
        );
        assert.equal(
          (
            await db.execute<{ rate: string }>(
              sql`select posting_rate_type as rate from subsidiary_accounting_preferences where org_id=${target}`,
              "objects",
            )
          )[0]?.rate,
          "corporate",
        );
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int from journal_reversal_instructions where org_id=${target}`,
              "objects",
            )
          )[0]?.count,
          0,
        );
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int from journal_reversal_instructions where org_id=${source.orgId}`,
              "objects",
            )
          )[0]?.count,
          1,
        );
        await assert.rejects(
          () =>
            withMaintenanceTransaction(null, async () => {
              await db.execute(
                sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`,
              );
              await db.execute(
                sql`update sandboxes set status='refreshing' where id=${sandbox!.sandboxId}`,
              );
              // Even in a registered clone lifecycle, a retained residual's changed
              // amount cannot use historical admission. The failed transaction rolls back.
              await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,period_id,amount,currency,txn_amount,fx_rate,is_currency_adjustment)
          select org_id,entry_id,line_number+100,account_id,subsidiary_id,period_id,2,currency,txn_amount,fx_rate,true
          from journal_lines where org_id=${target} and is_currency_adjustment`);
            }),
          (error) => errorChainMatches(error, /exact registered source row/),
        );
        await refreshSandbox(sandbox.sandboxId);
        assert.deepEqual(await projection(), [
          { amount: "1.0000", txn: "0.0000", currency: "USD", tagged: true, residual: "0.0000" },
        ]);
        await deleteSandbox(sandbox.sandboxId);
        sandbox = undefined;
      } finally {
        if (sandbox) await dropScratchOrgReporting(sandbox.sandboxOrgId);
        await dropScratchOrg(source.orgId);
      }
    },
  );
}

test(
  "clone flags cannot exempt a production destination or a modified historical financial row",
  { skip: !DB },
  async () => {
    const source = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const policyId = randomUUID();
      await db.execute(sql`insert into account_translation_policies(id,org_id,account_id,effective_from,general_rate_type,cash_flow_rate_type,reason)
      values(${policyId},${source.orgId},${source.accounts.bank},'2026-08-01','current','current','Treasury reporting policy')`);
      await assert.rejects(
        () =>
          withMaintenanceTransaction(null, async () => {
            await db.execute(
              sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`,
            );
            await db.execute(sql`insert into account_translation_policies(org_id,account_id,effective_from,general_rate_type,cash_flow_rate_type,reason)
        values(${source.orgId},${source.accounts.bank},'2026-09-01','current','current','Forged clone admission')`);
          }),
        (error) => errorChainMatches(error, /exact registered source row/),
      );
      sandbox = await withBypassContext(() =>
        createSandbox({
          productionOrgId: source.orgId,
          name: "Scratch clone refusal",
          tier: "full",
          masked: false,
        }),
      );
      await assert.rejects(
        () =>
          withMaintenanceTransaction(null, async () => {
            await db.execute(
              sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`,
            );
            await db.execute(
              sql`update sandboxes set status='refreshing' where id=${sandbox!.sandboxId}`,
            );
            // A registered active destination still cannot change a source policy's
            // recorded effective date or translation basis. The refusal rolls back.
            await db.execute(sql`insert into account_translation_policies(id,org_id,account_id,effective_from,general_rate_type,cash_flow_rate_type,reason)
        select ob_rebase(${policyId}::uuid,o.sandbox_seed),o.id,ob_rebase(${source.accounts.bank}::uuid,o.sandbox_seed),'2026-09-01','historical','current','Modified retained policy'
        from orgs o where o.id=${sandbox!.sandboxOrgId}`);
          }),
        (error) => errorChainMatches(error, /exact registered source row/),
      );
      await assert.rejects(
        () =>
          db.execute(
            sql`update account_translation_policies set general_rate_type='historical' where org_id=${source.orgId} and id=${policyId}`,
          ),
        (error) => errorChainMatches(error, /retained history/),
      );
      await deleteSandbox(sandbox.sandboxId);
      sandbox = undefined;
    } finally {
      if (sandbox) await dropScratchOrgReporting(sandbox.sandboxOrgId);
      await dropScratchOrg(source.orgId);
    }
  },
);
