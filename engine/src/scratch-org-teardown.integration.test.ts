import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import { receiveInventory, issueInventory } from "./inventory.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  dropScratchOrgReporting,
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
// In the bounded integration partition, dropScratchOrg recycles a leased org
// through the suite-global owner.  Destructive removal is reserved for pool
// close, so this test asserts exact baseline restoration in pooled mode while
// retaining the historical zero-row assertion for standalone runs.
const POOLED_FIXTURES = process.env.OPENBOOKS_TEST_FIXTURE_POOL === "1"
  || Boolean(process.env.OPENBOOKS_TEST_FIXTURE_OWNER_PORT);

test("dropScratchOrg removes every org-scoped row", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let dropped = false;
  const baselineCounts = POOLED_FIXTURES ? await orgRowCounts(org.orgId) : undefined;
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
              ${org.date}, ${org.date}, 'CAD', 1, 'draft', '100', '0', '100', false, '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount,
                                  tax_amount, is_billable, quantity_fulfilled, quantity_billed, stock_location_id, custom,
                                  tax_overridden, extra_dims)
      values (${randomUUID()}, ${org.orgId}, ${billId}, 1, null, ${org.accounts.cogs}, '1', '100', '100', '0',
              false, '0', '0', null, '{}'::jsonb, false, '{}'::jsonb)`);
    await db.execute(sql`
      update documents set status = 'approved'
       where id = ${billId} and org_id = ${org.orgId}
    `);
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

    // Payroll bank-file evidence: pay_run_bank_file_immutable forbids DELETE
    // outright and payroll_bank_file_blob_immutable blocks deleting the
    // referenced file_blobs row — teardown must disable both triggers and
    // clear the bank-file rows before the blob sweep.
    const folderId = randomUUID();
    await db.execute(sql`
      insert into folders (id, org_id, name)
      values (${folderId}, ${org.orgId}, 'Payroll bank files (teardown)')`);
    const fileId = randomUUID();
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderId}, 'PBF-0001.txt', 'text/plain', 4)`);
    const versionId = randomUUID();
    await db.execute(sql`
      insert into file_versions (id, file_id, version_number, size_bytes, content_type)
      values (${versionId}, ${fileId}, 1, 4, 'text/plain')`);
    await db.execute(sql`
      insert into file_blobs (version_id, bytes) values (${versionId}, ${Buffer.from("ABCD")})`);
    const formatId = randomUUID();
    await db.execute(sql`
      insert into payment_formats (id, org_id, code, name, rail)
      values (${formatId}, ${org.orgId}, 'cpa005', 'CPA-005 (teardown)', 'eft')`);
    const profileId = randomUUID();
    await db.execute(sql`
      insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency)
      values (${profileId}, ${org.orgId}, 'Teardown EFT', ${org.accounts.bank}, ${formatId}, 'CAD')`);
    const payRunDocId = await seedDraftDocument(org.orgId, { kind: "pay_run", createdBy: actorId });
    await db.execute(sql`
      insert into pay_run_bank_files
        (org_id, pay_run_document_id, payment_bank_profile_id, format, sequence_number, file_number,
         sequence_value, file_creation_number, filename, content_type, content_hash, size_bytes,
         file_id, file_version_id, entry_count, control_total, currency)
      values (${org.orgId}, ${payRunDocId}, ${profileId}, 'cpa005', 1, 'PBF-0001',
              1, 1, 'PBF-0001.txt', 'text/plain', ${"0".repeat(64)}, 4,
              ${fileId}, ${versionId}, 1, '100.00', 'CAD')`);

    await dropScratchOrg(org.orgId);
    dropped = true;

    // Standalone teardown is destructive; pooled teardown restores the exact
    // database-backed baseline snapshot so the leased org can be reused.
    const remainingCounts = await orgRowCounts(org.orgId);
    assert.deepEqual(remainingCounts, POOLED_FIXTURES ? baselineCounts : {});

    // file_versions/file_blobs carry no org_id, so the invariant above cannot
    // see them — assert the payroll blob chain is gone explicitly.
    const blobLeft = (await db.execute<{ versions: number; blobs: number }>(sql`
      select (select count(*)::int from file_versions where id = ${versionId}) as versions,
             (select count(*)::int from file_blobs where version_id = ${versionId}) as blobs`));
    assert.deepEqual(blobLeft.rows[0], { versions: 0, blobs: 0 });

    // And a second call is an idempotent no-op.
    await dropScratchOrg(org.orgId);
  } finally {
    if (!dropped) await dropScratchOrgReporting(org.orgId);
  }
});

test("dropScratchOrg commits durably from inside a pinned bypass transaction", { skip: !DB }, async () => {
  // The 2026-08-16 mass-purge phantom: called inside withBypass, the db proxy
  // used to fold every teardown transaction into the caller's single pinned
  // transaction — the wipe "succeeded", its own verification passed against
  // uncommitted state, and the caller's exit rolled the whole thing back. The
  // teardown must escape that scope, so its work survives even when the
  // surrounding withBypass block itself fails and rolls back.
  const org = await createScratchOrg();
  const baselineCounts = POOLED_FIXTURES ? await orgRowCounts(org.orgId) : undefined;
  try {
    const sentinel = new Error("outer transaction rolls back");
    await assert.rejects(
      withBypass(async () => {
        await dropScratchOrg(org.orgId);
        throw sentinel;
      }),
      sentinel,
    );
    const r = (await db.execute(sql`select 1 as x from orgs where id = ${org.orgId}`));
    assert.equal(
      r.rows.length,
      POOLED_FIXTURES ? 1 : 0,
      POOLED_FIXTURES
        ? "pooled drop must commit the reset while retaining the leased baseline org"
        : "the drop must be committed, not staged in the caller's transaction",
    );
    assert.deepEqual(await orgRowCounts(org.orgId), POOLED_FIXTURES ? baselineCounts : {});
  } finally {
    await dropScratchOrgReporting(org.orgId);
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
    const r = (await db.execute<{ envKind: string }>(sql`select env_kind as "envKind" from orgs where id = ${orgId}`));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.envKind, "production", "prep never ran against a refused org");
  } finally {
    // Rename into scope so the guarded teardown can clean up this fixture.
    await db.execute(sql`update orgs set name = ${"Scratch " + orgId.slice(0, 8)} where id = ${orgId}`);
    await dropScratchOrg(orgId);
  }
});
