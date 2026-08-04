import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  postDocument,
  regenerateGlImpactTx,
  type PostingDeps,
} from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "authorized source correction retains an idempotent original-reversal-replacement ledger chain",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Source Correction Controller", "admin");
    const documentId = randomUUID();
    const replacementPeriodId = randomUUID();
    const requestId = randomUUID();
    const applicationId = randomUUID();
    const settlementEntryId = randomUUID();
    const settlementLineId = randomUUID();
    const deps: PostingDeps = {
      migration: true,
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      },
    };
    try {
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        select ${replacementPeriodId}, org_id, fiscal_calendar_id, 2026, 8,
               '2026-08', '2026-08-01', '2026-08-31', false,
               '{"sourceId":"period-aug"}'::jsonb
          from accounting_periods
         where id = ${org.periodId}
      `);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status, subtotal,
           tax_total, total, custom, created_by, updated_by)
        values (
          ${documentId}, ${org.orgId}, 'vendor_bill', 'SOURCE-CORR-1',
          ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
          'CAD', 1, 'approved', 125, 0, 125,
          '{"sourceId":"transaction-1"}'::jsonb, ${actorId}, ${actorId}
        )
      `);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, custom, created_by, updated_by)
        values (
          ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, 1, 125,
          125, 0, '{}'::jsonb, ${actorId}, ${actorId}
        )
      `);
      const originalEntryId = await postDocument(documentId, deps, {
        audit: { actorId, source: "test" },
      });
      const originalOpenLine = (await db.execute(sql`
        select id
          from journal_lines
         where entry_id = ${originalEntryId} and is_open_item
      `)) as unknown as { rows: Array<{ id: string }> };
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin, created_by, updated_by)
        values (
          ${settlementEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
          'SETTLEMENT-1', ${org.date}, ${org.periodId}, 'Settlement source',
          'draft', 'manual', ${actorId}, ${actorId}
        )
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (
            ${settlementLineId}, ${org.orgId}, ${settlementEntryId}, 1,
            ${org.accounts.ap}, ${org.subsidiaryId}, 125, 'CAD', 125, 1,
              ${org.vendorId}, true
          ),
          (
            ${randomUUID()}, ${org.orgId}, ${settlementEntryId}, 2,
            ${org.accounts.bank}, ${org.subsidiaryId}, -125, 'CAD', -125, 1,
              null, false
          )
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_by = ${actorId}
         where id = ${settlementEntryId}
      `);
      await db.execute(sql`
        insert into applications
          (id, org_id, from_line_id, to_line_id, amount, source_amount,
           source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source,
           settlement_rate_reference, applied_on, created_by, updated_by)
        values (
          ${applicationId}, ${org.orgId}, ${settlementLineId},
          ${originalOpenLine.rows[0]!.id}, 125, 125, 125, 'CAD', 125, 'CAD',
          1, 'same_currency', 'source-application-1', ${org.date},
          ${actorId}, ${actorId}
        )
      `);

      const first = await db.transaction(async (tx) => {
        await tx.execute(sql`set local openbooks.amend = on`);
        await tx.execute(sql`set local openbooks.migration = on`);
        await tx.execute(sql`
          update documents
             set posting_period_id = ${replacementPeriodId}, updated_at = now()
           where id = ${documentId}
        `);
        return regenerateGlImpactTx(tx, documentId, deps, actorId, {
          actorId,
          requestId,
          reason: "Authorized source posting-period correction",
        });
      });
      assert.equal(first.changed, true);
      assert.ok(first.entryId);

      const chain = (await db.execute(sql`
        select document.posted_entry_id,
               original.status as original_status,
               original.period_id as original_period_id,
               reversal.id as reversal_entry_id,
               reversal.status as reversal_status,
               reversal.period_id as reversal_period_id,
               reversal.reverses_entry_id,
               replacement.status as replacement_status,
               replacement.period_id as replacement_period_id,
               replacement.posting_date::text as replacement_posting_date
          from documents document
          join journal_entries original on original.id = ${originalEntryId}
          join journal_entries reversal
            on reversal.reverses_entry_id = original.id
          join journal_entries replacement
            on replacement.id = document.posted_entry_id
         where document.id = ${documentId}
      `)) as unknown as {
        rows: Array<{
          posted_entry_id: string;
          original_status: string;
          original_period_id: string;
          reversal_entry_id: string;
          reversal_status: string;
          reversal_period_id: string;
          reverses_entry_id: string;
          replacement_status: string;
          replacement_period_id: string;
          replacement_posting_date: string;
        }>;
      };
      assert.deepEqual(chain.rows, [
        {
          posted_entry_id: first.entryId,
          original_status: "reversed",
          original_period_id: org.periodId,
          reversal_entry_id: chain.rows[0]!.reversal_entry_id,
          reversal_status: "posted",
          reversal_period_id: org.periodId,
          reverses_entry_id: originalEntryId,
          replacement_status: "posted",
          replacement_period_id: replacementPeriodId,
          replacement_posting_date: org.date,
        },
      ]);

      const byPeriod = (await db.execute(sql`
        select entry.period_id, line.account_id, sum(line.amount)::text as amount
          from journal_entries entry
          join journal_lines line on line.entry_id = entry.id
         where entry.id in (
           ${originalEntryId}, ${chain.rows[0]!.reversal_entry_id}, ${first.entryId}
         )
         group by entry.period_id, line.account_id
         order by entry.period_id, line.account_id
      `)) as unknown as {
        rows: Array<{ period_id: string; account_id: string; amount: string }>;
      };
      assert.deepEqual(
        byPeriod.rows.filter((row) => row.period_id === org.periodId),
        [
          { period_id: org.periodId, account_id: org.accounts.ap, amount: "0.0000" },
          { period_id: org.periodId, account_id: org.accounts.cogs, amount: "0.0000" },
        ].sort((left, right) => left.account_id.localeCompare(right.account_id)),
      );
      assert.deepEqual(
        byPeriod.rows.filter((row) => row.period_id === replacementPeriodId),
        [
          {
            period_id: replacementPeriodId,
            account_id: org.accounts.ap,
            amount: "-125.0000",
          },
          {
            period_id: replacementPeriodId,
            account_id: org.accounts.cogs,
            amount: "125.0000",
          },
        ].sort((left, right) => left.account_id.localeCompare(right.account_id)),
      );

      const audit = (await db.execute(sql`
        select changes->>'mode' as mode,
               changes->>'originalEntryId' as original_entry_id,
               changes->>'reversalEntryId' as reversal_entry_id,
               changes->>'replacementEntryId' as replacement_entry_id,
               actor_id, request_id
          from audit_log
         where org_id = ${org.orgId}
           and row_id = ${documentId}
           and changes->>'mode' = 'append_only_source_correction'
      `)) as unknown as {
        rows: Array<{
          mode: string;
          original_entry_id: string;
          reversal_entry_id: string;
          replacement_entry_id: string;
          actor_id: string;
          request_id: string;
        }>;
      };
      assert.deepEqual(audit.rows, [
        {
          mode: "append_only_source_correction",
          original_entry_id: originalEntryId,
          reversal_entry_id: chain.rows[0]!.reversal_entry_id,
          replacement_entry_id: first.entryId,
          actor_id: actorId,
          request_id: requestId,
        },
      ]);

      const applications = (await db.execute(sql`
        select application.id, application.unapplied_at is not null as unapplied,
               from_line.entry_id as from_entry_id,
               to_line.entry_id as to_entry_id
          from applications application
          join journal_lines from_line on from_line.id = application.from_line_id
          join journal_lines to_line on to_line.id = application.to_line_id
         where application.id = ${applicationId}
            or (
              application.org_id = ${org.orgId}
              and application.unapplied_at is null
              and application.from_line_id = ${settlementLineId}
            )
         order by application.created_at, application.id
      `)) as unknown as {
        rows: Array<{
          id: string;
          unapplied: boolean;
          from_entry_id: string;
          to_entry_id: string;
        }>;
      };
      assert.equal(applications.rows.length, 2);
      assert.deepEqual(applications.rows[0], {
        id: applicationId,
        unapplied: true,
        from_entry_id: settlementEntryId,
        to_entry_id: originalEntryId,
      });
      assert.deepEqual(applications.rows[1], {
        id: applications.rows[1]!.id,
        unapplied: false,
        from_entry_id: settlementEntryId,
        to_entry_id: first.entryId,
      });

      const retry = await db.transaction(async (tx) => {
        await tx.execute(sql`set local openbooks.amend = on`);
        await tx.execute(sql`set local openbooks.migration = on`);
        return regenerateGlImpactTx(tx, documentId, deps, actorId, {
          actorId,
          requestId,
          reason: "Authorized source posting-period correction",
        });
      });
      assert.deepEqual(retry, { entryId: first.entryId, changed: false });
      const count = await db.execute(sql`
        select count(*)::int as entries
          from journal_entries
         where source_document_id = ${documentId}
      `);
      assert.equal((count.rows[0] as { entries: number }).entries, 3);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
