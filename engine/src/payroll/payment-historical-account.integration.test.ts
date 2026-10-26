import { returnDocumentToDraft, submitAndReleaseIfUngated } from "../flows/submit.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";
import { recordPayRunPayment } from "./payment.ts";
import { commitPayRun } from "./run-commit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { payrollSettings } from "./run-setup.ts";

for (const caller of ["unrestricted", "scoped entity"] as const) {
  for (const policy of ["changed", "cleared"] as const) {
    test(
      `${caller} payroll settlement retains posted net-pay account after settings ${policy}`,
      { skip: !process.env.OPENBOOKS_DB_URL },
      async () => {
        const fx = await seedAdoption();
        try {
          const { input } = await calculatedRun(fx);
          await commitPayRun(input);
          const childId = caller === "scoped entity" ? randomUUID() : null;
          if (childId) {
            assert.equal(
              (
                await db.execute(
                  sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${childId},${fx.orgId},${fx.subsidiaryId},'Payroll entity','CAD','CA') returning id`,
                  "objects",
                )
              ).length,
              1,
            );
            // Establish entity ownership on the editable projection before posting freezes it.
            assert.equal(
              (
                await db.execute(
                  sql`update documents set subsidiary_id=${childId}
          where org_id=${fx.orgId} and id=${input.documentId} returning id`,
                  "objects",
                )
              ).length,
              1,
            );
            assert.equal(
              (
                await db.execute(
                  sql`update parties set subsidiary_id=${childId}
          where org_id=${fx.orgId} and id=${fx.employeeId} returning id`,
                  "objects",
                )
              ).length,
              1,
            );
          }
          const accounts = await db.execute<{ id: string; type: string }>(
            sql`
        select id,type from accounts where org_id=${fx.orgId}`,
            "objects",
          );
          const account = (type: string) => {
            const id = accounts.find((row) => row.type === type)?.id;
            assert.ok(id, `fixture account ${type}`);
            return id;
          };
          const bankAccountId = account("asset_bank");

          await postDocument(input.documentId, {
            control: {
              ar: account("asset_receivable"),
              ap: account("liability_payable"),
              bank: bankAccountId,
            },
          });
          const source = (
            await db.execute<{ id: string; account_id: string; amount: string }>(
              sql`
        select jl.id,jl.account_id,jl.amount from documents d
        join journal_lines jl on jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id
        where d.org_id=${fx.orgId} and d.id=${input.documentId}
          and jl.party_id=${fx.employeeId} and jl.is_open_item and jl.amount<0`,
              "objects",
            )
          )[0]!;
          assert.ok(source);
          const replacement = policy === "changed" ? account("liability_payable") : null;
          assert.notEqual(replacement, source.account_id);
          await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll,netPayAccountId}',
        ${JSON.stringify(replacement)}::jsonb) where id=${fx.orgId}`);

          const allowed = childId ? new Set([childId]) : null;
          if (allowed) {
            await assert.rejects(
              () => payrollSettings(fx.orgId, allowed),
              /payroll settings not found/,
            );
            // A later employee transfer cannot change ownership of the posted liability.
            assert.equal(
              (
                await db.execute(
                  sql`update parties set subsidiary_id=${fx.subsidiaryId}
          where org_id=${fx.orgId} and id=${fx.employeeId} returning id`,
                  "objects",
                )
              ).length,
              1,
            );
            for (const scope of [new Set<string>(), new Set([fx.subsidiaryId])]) {
              await assert.rejects(
                () => recordPayRunPayment({ ...input, bankAccountId, allowedSubsidiaryIds: scope }),
                /pay run not found/,
              );
            }
          }
          const payment = await recordPayRunPayment({
            ...input,
            bankAccountId,
            allowedSubsidiaryIds: allowed,
          });
          const settlement = await db.execute<{
            account_id: string;
            target_id: string;
            amount: string;
          }>(
            sql`
        select jl.account_id,a.to_line_id as target_id,a.amount from journal_lines jl
        join applications a on a.from_line_id=jl.id and a.org_id=jl.org_id
        where jl.org_id=${fx.orgId} and jl.entry_id=${payment.entryId}`,
            "objects",
          );
          assert.equal(settlement.length, 1);
          assert.equal(settlement[0]!.account_id, source.account_id);
          assert.equal(settlement[0]!.target_id, source.id);
          assert.equal(settlement[0]!.amount, source.amount.slice(1));
          const state = (
            await db.execute<{ paid_entry_id: string; balanced: boolean }>(
              sql`
        select paid_entry_id,(select sum(amount)=0 from journal_lines
          where org_id=${fx.orgId} and entry_id=${payment.entryId}) as balanced
        from pay_runs where org_id=${fx.orgId} and document_id=${input.documentId}`,
              "objects",
            )
          )[0]!;
          assert.deepEqual(state, { paid_entry_id: payment.entryId, balanced: true });
        } finally {
          await dropScratchOrgReporting(fx.orgId);
        }
      },
    );
  }
}

for (const evidence of ["absent", "ambiguous"] as const) {
  test(
    `payroll settlement refuses ${evidence} posted net-pay evidence atomically`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const fx = await seedAdoption();
      try {
        const { input } = await calculatedRun(fx);
        await commitPayRun(input);
        const accounts = await db.execute<{ id: string; type: string }>(
          sql`
        select id,type from accounts where org_id=${fx.orgId}`,
          "objects",
        );
        const account = (type: string) => {
          const id = accounts.find((row) => row.type === type)?.id;
          assert.ok(id, `fixture account ${type}`);
          return id;
        };
        const bankAccountId = account("asset_bank");
        // Review the unposted projection through its native draft transition;
        // posted evidence and ordinary posting/kernel controls remain immutable.
        await returnDocumentToDraft({
          ...input,
          actorId: fx.actorId,
          reason: "Review payroll liability evidence before posting",
        });
        if (evidence === "absent") {
          await db.execute(sql`update document_lines set party_id=null
          where org_id=${fx.orgId} and document_id=${input.documentId} and party_id=${fx.employeeId}`);
        } else {
          await db.execute(sql`update document_lines set amount=amount/2
          where org_id=${fx.orgId} and document_id=${input.documentId} and party_id=${fx.employeeId}`);
          await db.execute(sql`insert into document_lines
          (org_id,document_id,line_number,account_id,description,amount,party_id,created_by,updated_by)
          select org_id,document_id,
            (select max(line_number)+1 from document_lines where org_id=${fx.orgId} and document_id=${input.documentId}),
            ${account("liability_payable")},'Additional employee liability',amount,party_id,created_by,updated_by
          from document_lines where org_id=${fx.orgId} and document_id=${input.documentId} and party_id=${fx.employeeId}`);
        }
        await submitAndReleaseIfUngated("pay_run", input.documentId, fx.actorId);
        await postDocument(input.documentId, {
          control: {
            ar: account("asset_receivable"),
            ap: account("liability_payable"),
            bank: bankAccountId,
          },
        });
        await assert.rejects(
          () => recordPayRunPayment({ ...input, bankAccountId }),
          evidence === "absent" ? /no open net-pay items/ : /ambiguous net-pay account evidence/,
        );
        const state = (
          await db.execute<{
            paid_at: string | null;
            paid_entry_id: string | null;
            entries: number;
            applications: number;
          }>(
            sql`
        select paid_at,paid_entry_id,
          (select count(*)::int from journal_entries where org_id=${fx.orgId}) as entries,
          (select count(*)::int from applications where org_id=${fx.orgId}) as applications
        from pay_runs where org_id=${fx.orgId} and document_id=${input.documentId}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(state, {
          paid_at: null,
          paid_entry_id: null,
          entries: 1,
          applications: 0,
        });
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}
