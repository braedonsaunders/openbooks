import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { buildNativeContext } from "./sync/native.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "an explicit adjustment period overrides date-derived posting",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id
          from accounting_periods
         where id = ${org.periodId}
      `));
      const adjustmentPeriodId = randomUUID();
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        values (
          ${adjustmentPeriodId}, ${org.orgId},
          ${calendar.rows[0]!.fiscal_calendar_id},
          2026, 13, 'FY26 Adjustment', '2026-07-01', '2026-07-31', true,
          '{"nsId":"period-13"}'::jsonb
        )
      `);

      const documentId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, posting_period_id, currency, fx_rate,
           status, subtotal, tax_total, total, is_final_invoice, custom,
           extra_dims)
        values (
          ${documentId}, ${org.orgId}, 'vendor_bill', 'BILL-ADJ',
          ${org.vendorId}, ${org.subsidiaryId}, '2026-06-30', '2026-06-30',
          ${adjustmentPeriodId}, 'CAD', 1, 'approved', '100', '0', '100', false,
          '{}'::jsonb, '{}'::jsonb
        )
      `);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, quantity,
           unit_price, amount, tax_amount, is_billable, quantity_fulfilled,
           quantity_billed, custom, tax_overridden, extra_dims)
        values (
          ${randomUUID()}, ${org.orgId}, ${documentId}, 1,
          ${org.accounts.cogs}, '1', '100', '100', '0', false, '0', '0',
          '{}'::jsonb, false, '{}'::jsonb
        )
      `);

      const entryId = await postDocument(documentId, {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      });
      const entry = (await db.execute<{ period_id: string; posting_date: string }>(sql`
        select period_id, posting_date::text
          from journal_entries
         where id = ${entryId}
      `));

      assert.equal(entry.rows[0]!.period_id, adjustmentPeriodId);
      assert.equal(entry.rows[0]!.posting_date, "2026-06-30");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "connector period references fail closed when they are not unique",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id
          from accounting_periods
         where id = ${org.periodId}
      `));
      await db.execute(sql`
        update accounting_periods
           set custom = '{"nsId":"duplicate-period"}'::jsonb
         where id = ${org.periodId}
      `);
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        values (
          ${randomUUID()}, ${org.orgId},
          ${calendar.rows[0]!.fiscal_calendar_id},
          2026, 13, 'FY26 Adjustment', '2026-07-01', '2026-07-31', true,
          '{"nsId":"duplicate-period"}'::jsonb
        )
      `);

      await assert.rejects(
        buildNativeContext(org.orgId, "nsId", "CAD"),
        /maps to multiple accounting periods/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "connector control accounts fail closed on a cross-tenant UUID",
  { skip: !DB },
  async () => {
    const target = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             settings,
             '{controlAccounts,ap}',
             to_jsonb(${other.accounts.ap}::text),
             true
           )
         where id = ${target.orgId}
      `);
      await assert.rejects(
        buildNativeContext(target.orgId, "nsId", "CAD"),
        /control account ap does not belong to organization/,
      );
    } finally {
      await dropScratchOrg(target.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
