import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { runDueRecurringSchedules } from "./recurring.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** A monthly customer-invoice template; due_date null means no term spread. */
async function seedSchedule(
  org: ScratchOrg,
  actorId: string,
  partyId: string,
  dueDate: string | null,
): Promise<void> {
  const templateId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, due_date, currency,
       subtotal, tax_total, total, party_id, created_by)
    values (${templateId}, ${org.orgId}, 'customer_invoice', 'draft', ${"TPL-" + templateId.slice(0, 8)},
            ${org.date}, ${dueDate}, 'CAD', '100.00', '0.00', '100.00', ${partyId}, ${actorId})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, description, quantity, unit, unit_price, amount, created_by)
    values (${org.orgId}, ${templateId}, 1, ${org.accounts.revenue}, 'Recurring service',
            '1', 'ea', '100.00', '100.00', ${actorId})
  `);
  await db.execute(sql`
    insert into recurring_schedules
      (id, org_id, template_document_id, cadence, next_run_on, auto_post, is_active, name, created_by)
    values (${randomUUID()}, ${org.orgId}, ${templateId}, 'monthly', ${org.date}, false, true, 'Terms fixture', ${actorId})
  `);
}

async function draftDueDates(orgId: string): Promise<(string | null)[]> {
  const rows = await db.execute<{ due: string | null }>(
    sql`
    select due_date::text as due from documents
     where org_id = ${orgId} and kind = 'customer_invoice' and status = 'draft'
       and document_number not like 'TPL-%'
     order by due_date nulls last, document_number`,
    "objects",
  );
  return rows.map((row) => row.due);
}

test(
  "recurring drafts without a template spread fall back to customer terms",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb
      where org_id=${org.orgId} and key='admin'`);
      const net15 = randomUUID();
      await db.execute(sql`
      insert into payment_terms (id, org_id, name, net_days)
      values (${net15}, ${org.orgId}, 'Net 15', 15)`);
      await db.execute(sql`
      insert into customer_roles (org_id, party_id, payment_terms_id)
      values (${org.orgId}, ${org.customerId}, ${net15})`);
      // Template spread (+30) stays authoritative over the customer's Net 15.
      await seedSchedule(org, actorId, org.customerId, "2026-08-14");
      // No template spread: the draft follows the customer's Net 15 from the
      // run date, exactly like a hand-entered invoice.
      await seedSchedule(org, actorId, org.customerId, null);
      const run = await runDueRecurringSchedules(org.date);
      assert.equal(run.failed, 0);
      assert.equal(run.generated, 2);
      assert.deepEqual(await draftDueDates(org.orgId), ["2026-07-30", "2026-08-14"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "recurring drafts stay undated without template terms or customer terms",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb
      where org_id=${org.orgId} and key='admin'`);
      const bareCustomer = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${bareCustomer}, ${org.orgId}, 'customer', 'Terms-less Customer', true, '{}'::jsonb)`);
      await seedSchedule(org, actorId, bareCustomer, null);
      const run = await runDueRecurringSchedules(org.date);
      assert.equal(run.failed, 0);
      assert.equal(run.generated, 1);
      assert.deepEqual(await draftDueDates(org.orgId), [null]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
