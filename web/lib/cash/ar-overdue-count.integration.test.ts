import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/database";
import { postDocument } from "@openbooks/engine/documents";
import {
  createScratchOrg,
  dropScratchOrg,
  assertDedicatedFixtureDatabase,
} from "@openbooks/engine/testing/fixtures";
import { openItems } from "../cash/open-items";
import { buildWeekGrid, collectionsBalances } from "../cash/core";

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function postInvoice(
  org: Org,
  actor: string,
  input: { amount: string; docDate: string; due: string | null; subsidiaryId?: string },
) {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${id}, ${input.subsidiaryId ?? org.subsidiaryId}, ${org.customerId}, ${input.docDate}, ${input.due},
      'CAD', 1, ${input.amount}, 0, ${input.amount}, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, ${input.amount}, ${input.amount}, 0, ${input.amount})`);
  await db.execute(
    sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${id}`,
  );
  // postDocument resolves to the journal entry id; callers need the document id.
  await postDocument(id, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return id;
}

test(
  "the AR home overdue count and amount come from the same open-item row set",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { createScratchUser } = await import("@openbooks/engine/testing/fixtures");
      const actor = await withBypassContext(() =>
        createScratchUser(org.orgId, "AR Controller", "admin"),
      );
      const secondSub = randomUUID();
      await withBypassContext(async () => {
        const calendarId = (
          await db.execute(
            sql`select id from fiscal_calendars where org_id = ${org.orgId} limit 1`,
            "objects",
          )
        )[0]!.id as string;
        for (const [n, name, from, to] of [
          [5, "2026-05", "2026-05-01", "2026-05-31"],
          [6, "2026-06", "2026-06-01", "2026-06-30"],
        ] as const) {
          await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, 2026, ${n}, ${name}, ${from}, ${to}, false, ${calendarId})`);
        }
        await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${secondSub}, ${org.orgId}, ${org.subsidiaryId}, 'West', 'CAD', 'CA', '{}', false, true, '{}'::jsonb)`);
        await db.execute(sql`insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
        values (${randomUUID()}, ${org.orgId}, ${org.customerId}, ${secondSub})`);
        // Seven overdue posted invoices across two subsidiaries.
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          ids.push(
            await postInvoice(org, actor, {
              amount: "1000.0000",
              docDate: "2026-05-10",
              due: "2026-05-11",
            }),
          );
        }
        for (let i = 0; i < 2; i++) {
          ids.push(
            await postInvoice(org, actor, {
              amount: "2000.0000",
              docDate: "2026-06-10",
              due: "2026-06-11",
              subsidiaryId: secondSub,
            }),
          );
        }
        // Fully settle the first invoice: it must leave both the count and the amount.
        const payId = randomUUID();
        await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${payId}, ${org.orgId}, 'customer_payment', 'draft', ${payId}, ${org.subsidiaryId}, ${org.customerId}, '2026-06-20', null,
          'CAD', 1, '1000.0000', 0, '1000.0000', ${actor})`);
        await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${payId}, 1, ${org.accounts.bank}, 1, '1000.0000', '1000.0000', 0, '1000.0000')`);
        await db.execute(
          sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${payId}`,
        );
        await postDocument(payId, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
        const toLine = (
          await db.execute(
            sql`select jl.id from journal_lines jl join journal_entries je on je.id = jl.entry_id
        where jl.org_id = ${org.orgId} and je.source_document_id = ${ids[0]} and jl.is_open_item`,
            "objects",
          )
        )[0]?.id as string;
        // The payment's AR leg settles the invoice (from_line); receipt legs post
        // under the payment kind, which is not an open-item kind.
        const fromLine = (
          await db.execute(
            sql`select jl.id from journal_lines jl join journal_entries je on je.id = jl.entry_id
        where jl.org_id = ${org.orgId} and je.source_document_id = ${payId} and jl.account_id = ${org.accounts.ar}`,
            "objects",
          )
        )[0]?.id as string;
        await db.execute(sql`insert into applications
        (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
         source_transaction_currency, target_transaction_amount, target_transaction_currency,
         settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
        values (${org.orgId}, ${fromLine}, ${toLine}, '1000.0000', '2026-06-20', '1000.0000', '1000.0000', 'CAD', '1000.0000', 'CAD',
          '1', 'same_currency', 'T4-PROBE', ${actor}, ${actor})`);
      });
      await withOrgContext(org.orgId, async () => {
        // The AR position's collections figures: open items, the overdue count,
        // and the overdue amount off the same row set.
        const grid = buildWeekGrid("2026-07-15", 4);
        const items = await openItems(org.orgId, "ar", grid.asOfIso);
        const balances = collectionsBalances(items, grid.asOf);
        const count = balances.overdueCount;
        const amount = balances.overdue;
        const docs = await db.execute(
          sql`select d.id from documents d
        where d.org_id = ${org.orgId} and d.kind = 'customer_invoice' and d.status = 'posted'`,
          "objects",
        );
        assert.equal(docs.length, 7);
        // Six invoices still carry open balances totalling 8000.00; the settled
        // one leaves both the count and the amount.
        assert.equal(items.length, 6);
        assert.equal(count, 6);
        assert.equal(amount, "8000.0000");
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
