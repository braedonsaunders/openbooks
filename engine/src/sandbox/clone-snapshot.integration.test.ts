import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../test-fixtures.ts";
import { postDocument } from "../posting.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("a refresh racing production posts keeps a single consistent snapshot", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  const postInvoice = async (documentNumber: string): Promise<void> => {
    const userId = await createScratchUser(org.orgId, `Race ${documentNumber}`, "accountant");
    const invoiceId = randomUUID();
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${documentNumber},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
              'CAD', '1', '100', '0', '100', ${userId})`);
    await db.execute(sql`insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`update documents set status='approved' where id=${invoiceId} and org_id=${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  };
  try {
    await postInvoice("RACE-A");
    const created = await createSandbox({ productionOrgId: org.orgId, name: `Race ${randomUUID()}`, tier: "full", masked: false });
    sandboxId = created.sandboxId;
    const baseline = (await db.execute<{ documents: number; entries: number }>(sql`
      select (select count(*)::int from documents where org_id = ${org.orgId}) as documents,
             (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries
    `)).rows[0]!;
    // Balloon a table copied strictly between documents and journal_entries
    // so its copy runs for seconds: posting the moment that copy is active
    // lands the commit deterministically inside the torn-read window.
    await db.execute(sql`
      insert into dunning_log (org_id, document_id, policy_id, stage_id, amount_due)
      select ${org.orgId}, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '0'
        from generate_series(1, 40000)
    `);
    const refreshing = refreshSandbox(sandboxId, { keepCustomizations: true });
    const gateUntil = Date.now() + 60_000;
    for (;;) {
      const copying = (await db.execute<{ copying: boolean }>(sql`
        select exists(
          select 1 from pg_stat_activity
           where datname = current_database()
             and pid <> pg_backend_pid()
             and state = 'active'
             and query ilike '%insert into "dunning_log"%'
        ) as copying
      `)).rows[0]!.copying;
      if (copying) break;
      if (Date.now() > gateUntil) assert.fail("refresh never reached the dunning_log copy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await postInvoice("RACE-B");
    await refreshing;
    const clone = (await db.execute<{ documents: number; entries: number }>(sql`
      select (select count(*)::int from documents where org_id = ${created.sandboxOrgId}) as documents,
             (select count(*)::int from journal_entries where org_id = ${created.sandboxOrgId}) as entries
    `)).rows[0]!;
    // The race commit is invisible to a snapshot taken when the refresh
    // began: RACE-B's entry must not appear without its document.
    assert.equal(clone.documents, baseline.documents);
    assert.equal(clone.entries, baseline.entries);
  } finally {
    if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
