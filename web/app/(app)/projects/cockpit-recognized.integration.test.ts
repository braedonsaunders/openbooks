import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";

// Regression for B4-PRJ-01: the cockpit's recognized total joined the
// primary book on bk.is_primary alone, while the central run gates on
// is_active AND posts_gl. After the primary book was deactivated the card
// kept summing the dead book and disagreed with the run. The card now sums
// the same shared active posting primary the run posts to.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { loadProjectCockpit } = (await import("./_cockpit-data.ts")) as typeof import(
  "./_cockpit-data.ts"
);
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const fixedPrice = BUILTIN_PROJECT_TYPES.find((t) => t.key === "fixed_price")!;

test("the cockpit sums the live primary book, never a deactivated one", async () => {
  const org = await createScratchOrg();
  try {
    const typeId = randomUUID();
    const projectId = randomUUID();
    const contractId = randomUUID();
    const obligationId = randomUUID();
    const scheduleId = randomUUID();
    const entryId = randomUUID();
    await db.execute(sql`
      insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
      values (${typeId}, ${org.orgId}, 'cockpit-recognized-test', 'Cockpit test type', 'fixed_price',
              ${JSON.stringify(fixedPrice.invoicingProfile)}::jsonb,
              ${JSON.stringify(fixedPrice.backupProfile)}::jsonb)`);
    await db.execute(sql`
      insert into project_financial_profile_versions (org_id, project_type_id, effective_from, financial_profile, reason)
      values (${org.orgId}, ${typeId}, '2026-01-01',
              ${JSON.stringify(fixedPrice.financialProfile)}::jsonb, 'cockpit recognized fixture')`);
    await db.execute(sql`
      insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, project_type_id, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'RECOG-1', 'Recognized job',
              ${org.customerId}, 'active', true, ${typeId}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into revenue_contracts (id, org_id, project_id, customer_id, contract_number, total_transaction_price)
      values (${contractId}, ${org.orgId}, ${projectId}, ${org.customerId}, 'C-1', 1000)`);
    await db.execute(sql`
      insert into performance_obligations (id, org_id, contract_id, description, recognition_rule_id, allocated_price)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'Build', ${org.recognitionRuleId}, 1000)`);
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'RECOG-JE', ${org.date}, ${org.periodId}, 'recognition', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, 250, 'CAD', 250, '1'),
             (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, -250, 'CAD', -250, '1')`);
    await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      insert into recognition_schedules (id, org_id, obligation_id, book_id, total_amount)
      values (${scheduleId}, ${org.orgId}, ${obligationId}, ${org.bookId}, 1000)`);
    await db.execute(sql`
      insert into recognition_schedule_lines (org_id, schedule_id, period_id, sequence, planned_amount, recognized_amount, journal_entry_id)
      values (${org.orgId}, ${scheduleId}, ${org.periodId}, 1, 250, 250, ${entryId})`);

    const live = await loadProjectCockpit(org.orgId, projectId);
    assert.ok(live.recognition);
    assert.equal(live.recognition.recognized, "250.0000");

    // Deactivate the primary book: the run can no longer post there, so the
    // card must stop summing it too.
    await db.execute(sql`update accounting_books set is_active = false where id = ${org.bookId}`);
    const dead = await loadProjectCockpit(org.orgId, projectId);
    assert.ok(dead.recognition);
    assert.equal(dead.recognition.recognized, "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
