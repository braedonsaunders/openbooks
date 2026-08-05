import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { receiveInventory, issueInventory } from "./inventory.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  orgRowCounts,
  seedDraftDocument,
} from "./test-fixtures.ts";

/**
 * The teardown IS the subject under test. Scratch orgs live on the shared dev
 * database, so a teardown that misses one table leaks rows forever (the old
 * hardcoded table list did exactly that). Exercise the product surface —
 * posted documents/JEs, inventory cost layers, time entries, users/roles,
 * guarded field-ticket evidence — then drop the org and assert ZERO rows
 * remain across every org_id table the schema currently has.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("dropScratchOrg removes every org-scoped row", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let dropped = false;
  try {
    const actorId = await createScratchUser(org.orgId, "Teardown Actor", "accountant");
    const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };

    // Documents + journal entries: a POSTED vendor bill (posted_entry_id ↔
    // source_document_id is the FK cycle the teardown must break).
    const billId = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                             currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'BILL-TEARDOWN', ${org.vendorId}, ${org.subsidiaryId},
              ${org.date}, ${org.date}, 'CAD', 1, 'approved', '100', '0', '100', false, '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount,
                                  tax_amount, is_billable, quantity_fulfilled, quantity_billed, stock_location_id, custom,
                                  tax_overridden, extra_dims)
      values (${randomUUID()}, ${org.orgId}, ${billId}, 1, null, ${org.accounts.cogs}, '1', '100', '100', '0',
              false, '0', '0', null, '{}'::jsonb, false, '{}'::jsonb)`);
    await postDocument(billId, deps);

    // Inventory: receipts + an issue → posted inventory_movements, cost
    // layers, consumptions, and their journal entries.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2.00",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await issueInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "4",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.cogs, date: org.date,
    });

    // Time entries (the table the stale teardown was missing entirely).
    const employeeId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Teardown Worker', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${org.date}, 8, 'approved', false,
              'unbilled', 'actual', ${actorId}, ${actorId})`);

    // Guarded evidence: a field-ticket labor snapshot, whose retention guard
    // raises on ANY delete — teardown must take the trigger-disable path.
    const ticketId = await seedDraftDocument(org.orgId, { kind: "field_ticket", createdBy: actorId });
    await db.execute(sql`
      insert into field_tickets (document_id, org_id, period, period_start, period_end, created_by, updated_by)
      values (${ticketId}, ${org.orgId}, 'daily', ${org.date}, ${org.date}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into field_ticket_labor_snapshots (org_id, field_ticket_id, revision, evidence_basis, reason, currency, captured_by)
      values (${org.orgId}, ${ticketId}, 1, 'operational_time', 'teardown coverage', 'CAD', ${actorId})`);

    await dropScratchOrg(org.orgId);
    dropped = true;

    // The invariant: nothing org-scoped survives, in ANY org_id table.
    assert.deepEqual(await orgRowCounts(org.orgId), {});

    // And a second call is an idempotent no-op.
    await dropScratchOrg(org.orgId);
  } finally {
    if (!dropped) await dropScratchOrg(org.orgId).catch(() => {});
  }
});

test("dropScratchOrg refuses an org not named 'Scratch %'", { skip: !DB }, async () => {
  const orgId = randomUUID();
  await db.execute(sql`
    insert into orgs (id, name, base_currency, country, settings, env_kind)
    values (${orgId}, ${"Precious Production " + orgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb, 'production')`);
  try {
    await assert.rejects(dropScratchOrg(orgId), /refused/);
    // Still there — the refusal happened before any delete.
    const r = (await db.execute(sql`select env_kind as "envKind" from orgs where id = ${orgId}`)) as unknown as {
      rows: { envKind: string }[];
    };
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.envKind, "production", "prep never ran against a refused org");
  } finally {
    // Rename into scope so the guarded teardown can clean up this fixture.
    await db.execute(sql`update orgs set name = ${"Scratch " + orgId.slice(0, 8)} where id = ${orgId}`);
    await dropScratchOrg(orgId);
  }
});
