import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../../engine/src/db.ts";
import {
  createPaymentRun,
  PaymentError,
} from "../../../engine/src/payments.ts";
import { postDocument } from "../../../engine/src/posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../../engine/src/test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migrationSql = readFileSync(
  new URL("./0011_payment_run_live_selection.sql", import.meta.url),
  "utf8",
);

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    if (current instanceof Error && pattern.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

test(
  "outbound payment-run creation claims each source once and ignores cross-run instruction transitions",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(
        org.orgId,
        "Payment Source Contention Tester",
        "admin",
      );
      const formatId = randomUUID();
      const profileId = randomUUID();
      await db.execute(sql`
        insert into payment_formats
          (id, org_id, code, name, rail, direction, is_active, created_by)
        values
          (${formatId}, ${org.orgId}, 'outbound-source-contention',
           'Outbound source contention', 'cpa005_credit', 'credit', true,
           ${actorId})
      `);
      await db.execute(sql`
        insert into payment_bank_profiles
          (id, org_id, name, bank_account_id, subsidiary_id,
           payment_format_id, currency, require_run_approval, is_active,
           created_by)
        values
          (${profileId}, ${org.orgId}, 'Outbound contention bank',
           ${org.accounts.bank}, ${org.subsidiaryId}, ${formatId}, 'CAD',
           false, true, ${actorId})
      `);

      const postBill = async (number: string): Promise<string> => {
        const billId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id,
             party_id, document_date, posting_date, currency, fx_rate,
             subtotal, tax_total, total, created_by)
          values
            (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${number},
             ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, ${org.date},
             'CAD', '1', '100', '0', '100', ${actorId})
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, quantity,
             unit_price, amount, tax_amount, tax_input_amount, created_by)
          values
            (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '100',
             '100', '0', '0', ${actorId})
        `);
        await db.execute(sql`
          update documents
             set status = 'approved', updated_at = now(), updated_by = ${actorId}
           where id = ${billId} and org_id = ${org.orgId}
        `);
        await postDocument(billId, {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        });
        return billId;
      };

      const racedBillId = await postBill("BILL-OUTBOUND-CONTENTION");
      const createOpts = {
        orgId: org.orgId,
        createdBy: actorId,
        paymentBankProfileId: profileId,
        billDocumentIds: [racedBillId],
      };
      const raced = await Promise.allSettled([
        createPaymentRun(createOpts),
        createPaymentRun(createOpts),
      ]);
      const winners = raced.filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          id: string;
          runNumber: string;
        }> => result.status === "fulfilled",
      );
      const losers = raced.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      assert.ok(losers[0]!.reason instanceof PaymentError);
      assert.match(
        losers[0]!.reason.message,
        /already reserved by another live payment run/,
      );

      const artifacts = await db.execute<{
        live_runs: number;
        live_claims: number;
        draft_payments: number;
      }>(sql`
        select
          (select count(*)::int
             from payment_runs
            where org_id = ${org.orgId} and status = 'draft') as live_runs,
          (select count(*)::int
             from payment_run_items
            where org_id = ${org.orgId}
              and source_document_id = ${racedBillId}
              and status = 'selected') as live_claims,
          (select count(*)::int
             from documents
            where org_id = ${org.orgId}
              and kind = 'vendor_payment'
              and status = 'draft') as draft_payments
      `);
      assert.deepEqual(artifacts.rows[0], {
        live_runs: 1,
        live_claims: 1,
        draft_payments: 1,
      });

      const firstRunId = winners[0]!.value.id;
      const secondBillId = await postBill("BILL-CROSS-RUN-INSTRUCTION");
      const secondRun = await createPaymentRun({
        ...createOpts,
        billDocumentIds: [secondBillId],
      });
      const identities = await db.execute<{
        first_item_id: string;
        first_instruction_id: string;
        second_instruction_id: string;
      }>(sql`
        select
          (select id
             from payment_run_items
            where org_id = ${org.orgId} and payment_run_id = ${firstRunId}
            limit 1) as first_item_id,
          (select id
             from payment_instructions
            where org_id = ${org.orgId} and payment_run_id = ${firstRunId}
            limit 1) as first_instruction_id,
          (select id
             from payment_instructions
            where org_id = ${org.orgId} and payment_run_id = ${secondRun.id}
            limit 1) as second_instruction_id
      `);
      const identity = identities.rows[0]!;

      await assert.rejects(
        db.execute(sql`
          update payment_run_items
             set payment_instruction_id = ${identity.second_instruction_id}
           where id = ${identity.first_item_id} and org_id = ${org.orgId}
        `),
        (error: unknown) =>
          errorChainMatches(error, /payment_run_items_instruction_run/),
      );

      // A legacy cross-run link must stop the rollout before its instruction
      // status can drive the migration backfill. The whole setup rolls back
      // with the expected preflight failure, including the temporary DDL.
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(
            sql.raw(`
            alter table public.payment_run_items
            drop constraint payment_run_items_instruction_run
          `),
          );
          await tx.execute(sql`
            update payment_run_items
               set payment_instruction_id = ${identity.second_instruction_id}
             where id = ${identity.first_item_id} and org_id = ${org.orgId}
          `);
          await tx.execute(sql`
            update payment_instructions
               set status = 'sent', updated_by = ${actorId}
             where id = ${identity.second_instruction_id} and org_id = ${org.orgId}
          `);
          await tx.execute(sql.raw(migrationSql));
        }),
        (error: unknown) =>
          errorChainMatches(
            error,
            /cannot enforce live payment-run selection: org .* payment-run item .* references an instruction of another payment run/,
          ),
      );

      // Model that same legacy link without running the migration. The
      // lifecycle trigger independently fails closed: an instruction advances
      // claims owned by its own run and no other.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`
          alter table public.payment_run_items
          drop constraint payment_run_items_instruction_run
        `),
        );
        await tx.execute(sql`
          update payment_run_items
             set payment_instruction_id = ${identity.second_instruction_id}
           where id = ${identity.first_item_id} and org_id = ${org.orgId}
        `);
        await tx.execute(sql`
          update payment_instructions
             set status = 'sent', updated_by = ${actorId}
           where id = ${identity.second_instruction_id} and org_id = ${org.orgId}
        `);
        const crossRunClaim = await tx.execute<{ status: string }>(sql`
          select status
            from payment_run_items
           where id = ${identity.first_item_id} and org_id = ${org.orgId}
        `);
        assert.equal(crossRunClaim.rows[0]!.status, "selected");
        const sameRunClaim = await tx.execute<{ status: string }>(sql`
          select status
            from payment_run_items
           where payment_run_id = ${secondRun.id} and org_id = ${org.orgId}
           limit 1
        `);
        assert.equal(sameRunClaim.rows[0]!.status, "paid");
        await tx.execute(sql`
          update payment_run_items
             set payment_instruction_id = ${identity.first_instruction_id}
           where id = ${identity.first_item_id} and org_id = ${org.orgId}
        `);
        await tx.execute(
          sql.raw(`
          alter table public.payment_run_items
          add constraint payment_run_items_instruction_run
          foreign key (org_id, payment_run_id, payment_instruction_id)
          references public.payment_instructions (org_id, payment_run_id, id)
          deferrable
        `),
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
