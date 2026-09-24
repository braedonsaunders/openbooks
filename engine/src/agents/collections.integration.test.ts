import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import { runContinuousCloseAgent } from "../continuous-close/continuous-close.ts";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { collectionsFindings } from "./collections.ts";

/**
 * Live-PostgreSQL proof for the collections pack with its production loaders:
 * overdue ageing, the materiality floor, broken promises, credit-hold gates,
 * and org isolation (a second tenant's arrears never leak in).
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "late-payment statistics count the invoice target leg once and age it from that invoice",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const today = await withBypassContext(() => businessToday(org.orgId));
      const actors = await seedFlowActors(org.orgId);
      const party = await seedParty(org.orgId, "Late Credit Customer");
      const invoiceId = await seedInvoice(org, party, "INV-LATE-LEG", minusDays(today, 45), "5000.00");
      const targetLine = (await db.execute<{ id: string }>(sql`
        select line.id
          from documents document
          join journal_lines line on line.entry_id = document.posted_entry_id
           and line.org_id = document.org_id and line.account_id = ${org.accounts.ar}
         where document.id = ${invoiceId} and document.org_id = ${org.orgId}
      `)).rows[0]!.id;

      // A posted credit memo has an older due date than its invoice target.
      // The old OR join counted this application twice and used that source
      // due date for worstLateDays.
      const entryId = randomUUID();
      const sourceDueDate = minusDays(today, 200);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, status, origin, created_by, updated_by)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
                ${entryId}, ${org.date}, ${org.periodId}, 'draft', 'manual',
                ${actors.adminId}, ${actors.adminId})
      `);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, party_id, due_date, is_open_item)
        values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId},
                '-100', 'CAD', '-100', '1', ${party}, ${sourceDueDate}, true),
               (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId},
                '100', 'CAD', '100', '1', ${party}, ${sourceDueDate}, false)
      `);
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`);
      const sourceLine = (await db.execute<{ id: string }>(sql`
        select id from journal_lines where entry_id = ${entryId} and line_number = 1 and org_id = ${org.orgId}
      `)).rows[0]!.id;
      await db.execute(sql`
        insert into applications
          (org_id, from_line_id, to_line_id, amount, source_amount,
           source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference,
           applied_on, created_by)
        values (${org.orgId}, ${sourceLine}, ${targetLine}, '1', '1', '1', 'CAD',
                '1', 'CAD', '1', 'same_currency', 'late-credit-test',
                ${minusDays(today, 1)}, ${actors.adminId})
      `);

      const findings = await withBypassContext(() =>
        collectionsFindings(org.orgId, "1000.0000", defaultContinuousCloseDetectors("collections")),
      );
      const customer = findings.find((finding) => finding.findingType === "overdue_customer_balance" && finding.subjectId === party);
      assert.ok(customer);
      assert.equal(customer.summary.latePayments, 1);
      assert.equal(customer.summary.worstLateDays, 44);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

function minusDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function plusDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function seedParty(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(
    () => db.execute(sql`
      insert into parties (id, org_id, kind, display_name)
      values (${id}, ${orgId}, 'customer', ${name})`),
  );
  return id;
}

async function seedInvoice(
  org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; date: string; accounts: Record<string, string> },
  partyId: string,
  number: string,
  dueDate: string,
  total: string,
  expectedPayDate: string | null = null,
): Promise<string> {
  const id = randomUUID();
  const entryId = randomUUID();
  await withBypassContext(
    () => db.transaction(async (tx) => {
      await tx.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryId}, ${org.date}, ${org.periodId}, 'draft', 'manual')`);
      await tx.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, due_date, is_open_item)
        values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, ${total}, 'CAD', ${total}, 1, ${partyId}, ${dueDate}, true),
               (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${`-${total}`}, 'CAD', ${`-${total}`}, 1, ${partyId}, ${dueDate}, false)`);
      await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
      await tx.execute(sql`
        insert into documents
          (id, org_id, subsidiary_id, kind, status, document_number, document_date, due_date,
           currency, subtotal, tax_total, total, open_balance, party_id, expected_pay_date,
           posted_entry_id, posting_period_id)
        values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'customer_invoice', 'posted', ${number}, ${dueDate}, ${dueDate},
                'CAD', ${total}, '0', ${total}, ${total}, ${partyId}, ${expectedPayDate},
                ${entryId}, ${org.periodId})`);
    }),
  );
  return id;
}

test(
  "collections pack ages arrears, honours the floor, and isolates tenants",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const other = await withBypass(() => createScratchOrg());
    try {
      const today = await withBypassContext(() => businessToday(org.orgId));
      const big = await seedParty(org.orgId, "Big Debtor");
      await seedInvoice(org, big, "INV-A1", minusDays(today, 45), "5000", minusDays(today, 20));
      await seedInvoice(org, big, "INV-A2", minusDays(today, 10), "500.00");
      await seedInvoice(org, big, "INV-A3", plusDays(today, 30), "7000.00");

      const small = await seedParty(org.orgId, "Small Debtor");
      await seedInvoice(org, small, "INV-B1", minusDays(today, 20), "10.00");

      const hold = await seedParty(org.orgId, "Hold Candidate");
      await seedInvoice(org, hold, "INV-C1", minusDays(today, 70), "2000.00");
      await seedInvoice(org, hold, "INV-C2", minusDays(today, 70), "2000.00");
      await seedInvoice(org, hold, "INV-C3", minusDays(today, 70), "2000.00");

      const current = await seedParty(org.orgId, "Current Payer");
      await seedInvoice(org, current, "INV-D1", plusDays(today, 15), "9000.00");

      const foreign = await seedParty(other.orgId, "Foreign Debtor");
      await seedInvoice(other, foreign, "INV-X1", minusDays(today, 100), "99999.00");

      const findings = await withBypassContext(() =>
        collectionsFindings(org.orgId, "1000.0000", defaultContinuousCloseDetectors("collections")),
      );
      const byType = (type: string) => findings.filter((finding) => finding.findingType === type);

      const overdue = byType("overdue_customer_balance");
      assert.equal(overdue.length, 2, "big + hold debtors; small is below the floor, current is not overdue");
      assert.ok(
        overdue.every((finding) => finding.materiality !== "99999.00"),
        "the other tenant's arrears never leak in",
      );
      const first = overdue.find((finding) => finding.subjectId === hold)!;
      const second = overdue.find((finding) => finding.subjectId === big)!;
      assert.ok(first && second, "both arrears customers surface");
      assert.equal(first.materiality, "6000.0000", "hold candidate ranks first by overdue balance");
      assert.equal(first.summary.callPriority, 1);
      assert.equal(second.materiality, "5500.0000", "current invoice excluded from the arrears");
      assert.equal(second.summary.callPriority, 2);
      assert.equal(second.summary.callListSize, 2);
      assert.equal(first.severity, "critical", "70-day-old arrears escalate");
      assert.equal(second.severity, "critical", "45-day-old arrears escalate");
      assert.match(String(second.summary.reminderDraft), /Big Debtor/);
      assert.ok(
        second.evidence.some((item) => item.kind === "overdue_invoice" && item.sourceType === "document"),
        "overdue invoices ride along as evidence",
      );

      const promises = byType("broken_payment_promise");
      assert.equal(promises.length, 1, "only the breached expected-pay-date fires");
      assert.equal(promises[0]!.materiality, "5000.0000");
      assert.equal(promises[0]!.summary.brokenCount, 1);

      const holds = byType("credit_hold_candidate");
      assert.equal(holds.length, 1, "only the 70-day, 3-invoice, 6x case qualifies");
      assert.equal(holds[0]!.subjectId, hold);
      assert.equal(holds[0]!.materiality, "6000.0000");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

test(
  "collections findings persist through a full agent run (migration 0151 admits the key)",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const today = await withBypassContext(() => businessToday(org.orgId));
      const party = await seedParty(org.orgId, "Persistent Debtor");
      await seedInvoice(org, party, "INV-P1", minusDays(today, 40), "2500.00");
      await withBypassContext(
        () => db.execute(sql`
          insert into ai_agent_policies (org_id, agent_key, enabled, materiality_threshold)
          values (${org.orgId}, 'collections', true, 1000)`),
      );

      const result = await withBypassContext(() =>
        runContinuousCloseAgent({
          orgId: org.orgId,
          agentKey: "collections",
          trigger: "manual",
          allowedSubsidiaryIds: null, // test setup: unrestricted system scan
        }),
      );
      assert.notEqual((result as { status: string }).status, "claimed_elsewhere");
      const run = result as { status: string; detected: number };
      assert.equal(run.status, "completed");
      assert.equal(run.detected, 1);

      const items = await withBypassContext(
        () => db.execute<{ finding_type: string; materiality: string }>(sql`
          select finding_type, materiality::text
            from ai_work_items where org_id = ${org.orgId} and agent_key = 'collections'`),
      );
      assert.equal(items.rows.length, 1);
      assert.equal(items.rows[0]!.finding_type, "overdue_customer_balance");
      assert.equal(items.rows[0]!.materiality, "2500.0000");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
