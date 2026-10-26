import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/database";
import { postDocument } from "@openbooks/engine/documents";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  assertDedicatedFixtureDatabase,
} from "@openbooks/engine/testing/fixtures";
import { openItems } from "../cash/open-items";
import { receivablesIntelligenceData } from "./receivables-intelligence-data";
import { withAnalyticsRead } from "./read-context";

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function postInvoice(
  org: Org,
  actor: string,
  input: { amount: string; docDate: string; due: string | null },
) {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${id}, ${org.subsidiaryId}, ${org.customerId}, ${input.docDate}, ${input.due},
      'CAD', 1, ${input.amount}, 0, ${input.amount}, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, ${input.amount}, ${input.amount}, 0, ${input.amount})`);
  const approved = await db.execute(
    sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${id} returning id`,
    "objects",
  );
  assert.equal(approved.length, 1);
  // postDocument resolves to the journal entry id; callers need the document id.
  await postDocument(id, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return id;
}

async function payInvoice(
  org: Org,
  actor: string,
  invoiceId: string,
  amount: string,
  appliedOn: string,
) {
  const payId = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${payId}, ${org.orgId}, 'customer_payment', 'draft', ${payId}, ${org.subsidiaryId}, ${org.customerId}, ${appliedOn}, null,
      'CAD', 1, ${amount}, 0, ${amount}, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${payId}, 1, ${org.accounts.bank}, 1, ${amount}, ${amount}, 0, ${amount})`);
  await db.execute(
    sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${payId}`,
  );
  await postDocument(payId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  const toLine = (
    await db.execute<{ id: string }>(
      sql`select jl.id from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where jl.org_id = ${org.orgId} and je.source_document_id = ${invoiceId} and jl.is_open_item`,
      "objects",
    )
  )[0]?.id;
  // The payment's AR leg settles the invoice (from_line); receipt legs post
  // under the payment kind, which is not an open-item kind.
  const fromLine = (
    await db.execute<{ id: string }>(
      sql`select jl.id from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where jl.org_id = ${org.orgId} and je.source_document_id = ${payId} and jl.account_id = ${org.accounts.ar}`,
      "objects",
    )
  )[0]?.id;
  assert.ok(toLine && fromLine, "the invoice open-item line and the payment AR leg must exist");
  await db.execute(sql`insert into applications
    (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
     source_transaction_currency, target_transaction_amount, target_transaction_currency,
     settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
    values (${org.orgId}, ${fromLine}, ${toLine}, ${amount}, ${appliedOn}, ${amount}, ${amount}, 'CAD', ${amount}, 'CAD',
      '1', 'same_currency', 'T3-PROBE', ${actor}, ${actor})`);
}

test(
  "collection attention follows the stated as-of date and native due-on-receipt terms",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Collections Controller", "admin");
      let dueOnReceiptInvoice = "";
      await withBypassContext(async () => {
        const calendarId = (
          await db.execute(
            sql`select id from fiscal_calendars where org_id = ${org.orgId} limit 1`,
            "objects",
          )
        )[0]!.id as string;
        for (const [n, name, from, to] of [
          [4, "2026-04", "2026-04-01", "2026-04-30"],
          [5, "2026-05", "2026-05-01", "2026-05-31"],
          [6, "2026-06", "2026-06-01", "2026-06-30"],
        ] as const) {
          await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, 2026, ${n}, ${name}, ${from}, ${to}, false, ${calendarId})`);
        }
        const severe = await postInvoice(org, actor, {
          amount: "10000.0000",
          docDate: "2026-04-10",
          due: "2026-04-11",
        });
        await postInvoice(org, actor, {
          amount: "5000.0000",
          docDate: "2026-07-10",
          due: "2026-07-11",
        });
        dueOnReceiptInvoice = await postInvoice(org, actor, {
          amount: "7000.0000",
          docDate: "2026-07-05",
          due: null,
        });
        await payInvoice(org, actor, severe, "10000.0000", "2026-07-18");
      });
      await withOrgContext(org.orgId, async () => {
        const authz = {
          user: {
            orgId: org.orgId,
            id: actor,
            email: "controller@scratch.test",
            name: "Collections Controller",
            roles: [],
            envKind: "production" as const,
            productionOrgId: org.orgId,
            homeOrgId: org.orgId,
            homeUserId: actor,
            isSuperAdmin: false,
          },
          permissions: new Set(["reports.read", "ar.read"]),
          allowedSubsidiaryIds: null,
        };
        const context = {
          authz,
          slug: "receivables-intelligence",
          locale: "en",
          revision: randomUUID(),
          observedAt: Date.now(),
          projection: "summary" as const,
          tab: "",
        };
        await withAnalyticsRead(context, async () => {
          const mid = await receivablesIntelligenceData(
            org.orgId,
            "2026-07-01",
            "2026-07-15",
            null,
            {},
          );
          const late = await receivablesIntelligenceData(
            org.orgId,
            "2026-07-01",
            "2026-07-25",
            null,
            {},
          );
          const itemsMid = await openItems(org.orgId, "ar", "2026-07-15");
          const itemsLate = await openItems(org.orgId, "ar", "2026-07-25");
          assert.equal(mid.asOf, "2026-07-15");
          // Posting stamps due-on-receipt when neither party nor organization supplies terms.
          const immediate = itemsMid.find((item) => item.docId === dueOnReceiptInvoice);
          assert.ok(immediate?.dueDate, "the posted invoice retains its resolved due date");
          assert.equal(immediate.dueDate.toISOString().slice(0, 10), "2026-07-05");
          // The intelligence overdue agrees with open items as of the same date.
          assert.equal(mid.summary.overdue, "22000.0000");
          assert.equal(late.summary.overdue, "12000.0000");
          // Attention is party-level: the single fixture customer holds a severe
          // invoice at mid, so its whole overdue balance needs attention. It
          // moves with postings between the two dates.
          assert.equal(mid.summary.attention, "22000.0000");
          assert.equal(late.summary.attention, "0.0000");
          assert.ok(itemsLate.length < itemsMid.length);
        });
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
