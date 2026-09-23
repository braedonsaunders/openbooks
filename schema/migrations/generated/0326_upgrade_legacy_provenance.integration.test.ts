import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migrationSql = readFileSync(
  new URL("./0326_upgrade_legacy_provenance.sql", import.meta.url),
  "utf8",
);

/**
 * 0326 records exactly the rows whose pre-upgrade past was backfilled, not
 * recorded — one shared registry every lane reads by membership.
 *
 * Prior-release fixtures carry 2020 timestamps (older than any upgrade
 * ledger stamp, exactly like real pre-upgrade rows); post-upgrade controls
 * use current timestamps and must stay unmarked. Each class also gets a
 * negative control proving the criterion, not just the timestamp, decides:
 * an old but unreferenced rule, a fresh writer pin, a draft waiver, an
 * uncompleted document, draft counts.
 *
 * Everything runs inside one transaction that always rolls back: the posted
 * duplicates and the posted negative only exist in pre-guard installs, so
 * the test drops their guards (0293 unique, 0299 check) to plant the true
 * legacy shape without depending on other lanes' exemptions — and the
 * rollback restores both constraints, so parallel suites never observe a
 * guardless table. The scratch org itself is created outside (and dropped
 * after) because teardown cannot run inside the rolled-back unit.
 */
const LEGACY_DAY = "2020-01-15";
const ROLLBACK = Symbol("0326-test-rollback");

async function provenance(orgId: string) {
  return (await db.execute<{ migration: string; table_name: string; row_id: string; note: string }>(sql`
    select migration, table_name, row_id::text as row_id, note
      from upgrade_legacy_provenance
     where org_id = ${orgId}
     order by migration, row_id
  `)).rows;
}

test("0326 records the six legacy classes and nothing else, idempotently", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  const actorId = randomUUID();
  const oldRule = randomUUID();
  const staleRule = randomUUID();
  const freshRule = randomUUID();
  const oldPin = randomUUID();
  const newPin = randomUUID();
  const signedWaiver = randomUUID();
  const voidWaiver = randomUUID();
  const draftWaiver = randomUUID();
  const legacyDoc = randomUUID();
  const freshDoc = randomUUID();
  const openDoc = randomUUID();
  const dupA = randomUUID();
  const dupB = randomUUID();
  const negLine = randomUUID();
  try {
    // One pinned transaction for everything below; the sentinel rolls it
    // all back (guards restored, fixtures vanished). A real failure still
    // propagates: only the sentinel is swallowed.
    await withBypass(() =>
      db.transaction(async () => {
        // Pre-guard install shape: the grandfathered rows cannot exist
        // under the 0293/0299 guards, so plant them with both guards down.
        // The rollback restores the constraints.
        await db.execute(sql`
          alter table stock_count_lines drop constraint if exists stock_count_lines_no_duplicate_subject`);
        // g43's staged 0293 enforces the guard as a partial unique INDEX of
        // the same name (a constraint on older ledgers); drop whichever exists.
        await db.execute(sql`drop index if exists stock_count_lines_no_duplicate_subject`);
        await db.execute(sql`
          alter table stock_count_lines drop constraint if exists stock_count_lines_counted_nonnegative`);

        // -- 0297: a pre-versioning rule pinned by an obligation (marked), an
        // -- old rule nothing references, and a fresh rule (both unmarked).
      for (const [id, created] of [[oldRule, LEGACY_DAY], [staleRule, LEGACY_DAY]] as const) {
        await db.execute(sql`
          insert into recognition_rules
            (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
             period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id,
             is_active, created_at, updated_at)
          values (${id}, ${org.orgId}, ${`LEGACY-${id.slice(0, 8)}`}, 'Legacy rule', 'straight_line_even', false, 12,
                  'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized},
                  true, ${created}::timestamptz, ${created}::timestamptz)`);
      }
      await db.execute(sql`
        insert into recognition_rules
          (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
           period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
        values (${freshRule}, ${org.orgId}, 'FRESH-1', 'Fresh rule', 'straight_line_even', false, 12,
                'obligation', 'term', 0, 0, '0', ${org.accounts.deferred}, ${org.accounts.recognized}, true)`);
      const contractId = randomUUID();
      await db.execute(sql`
        insert into revenue_contracts
          (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
        values (${contractId}, ${org.orgId}, ${org.customerId}, 'LEGACY-001', 'active', '2020-02-01',
                'CAD', '12000', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into performance_obligations
          (id, org_id, contract_id, description, recognition_rule_id, booked_amount, allocated_price,
           recognition_starts_on, status, created_by, updated_by)
        values (${randomUUID()}, ${org.orgId}, ${contractId}, 'Legacy obligation', ${oldRule},
                '12000', '12000', '2020-02-01', 'open', ${actorId}, ${actorId})`);

      // -- 0298: a backfilled pin (marked) and a writer pin saved after the
      // -- upgrade (unmarked).
      const book = randomUUID();
      const oldVersion = randomUUID();
      const newVersion = randomUUID();
      await db.execute(sql`
        insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${book}, ${org.orgId}, 'LEGACY-RATES', 'Legacy rates', 'CAD', false, true)`);
      await db.execute(sql`
        insert into item_rate_profiles (org_id, item_id, base_unit, pricing_policy, invoice_presentation, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components', true)`);
      for (const [version, from, to] of [[oldVersion, '2020-01-01', '2020-01-31'], [newVersion, '2020-02-01', null]] as const) {
        await db.execute(sql`
          insert into item_rate_versions (id, org_id, rate_book_id, effective_from, effective_to, status, custom)
          values (${version}, ${org.orgId}, ${book}, ${from}, ${to}, 'draft', '{}'::jsonb)`);
        await db.execute(sql`
          insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
          values (${org.orgId}, ${version}, ${org.items.service}, 'one', 'One', 1, 10, 10)`);
      }
      await db.execute(sql`
        update item_rate_versions set status = 'active'
         where org_id = ${org.orgId} and rate_book_id = ${book}`);
      await db.execute(sql`
        insert into item_rate_version_profiles
          (id, org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation, created_at, updated_at)
        values (${oldPin}, ${org.orgId}, ${oldVersion}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components',
                ${LEGACY_DAY}::timestamptz, ${LEGACY_DAY}::timestamptz)`);
      await db.execute(sql`
        insert into item_rate_version_profiles (id, org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation)
        values (${newPin}, ${org.orgId}, ${newVersion}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components')`);

      // -- 0292: a signed waiver and a void-with-signature waiver without a
      // -- snapshot (marked), plus a draft (unmarked).
      const partyId = randomUUID();
      const projectId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${partyId}, ${org.orgId}, 'vendor', 'Legacy Vendor', ${org.subsidiaryId}, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'LEGACY', 'Legacy project', ${org.customerId}, 'active', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into lien_waivers
          (id, org_id, waiver_number, direction, party_id, project_id, waiver_type, status, through_date, amount, currency,
           signed_by_name, signed_at, created_by, updated_by)
        values (${signedWaiver}, ${org.orgId}, 'LW-LEG-1', 'received', ${partyId}, ${projectId}, 'conditional_progress',
                'signed', '2020-01-31', '1000.00', 'CAD', 'A. Signer', ${LEGACY_DAY}::timestamptz, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into lien_waivers
          (id, org_id, waiver_number, direction, party_id, project_id, waiver_type, status, through_date, amount, currency,
           signed_by_name, signed_at, void_reason, created_by, updated_by)
        values (${voidWaiver}, ${org.orgId}, 'LW-LEG-2', 'received', ${partyId}, ${projectId}, 'conditional_progress',
                'void', '2020-01-31', '1000.00', 'CAD', 'A. Signer', ${LEGACY_DAY}::timestamptz,
                'superseded by reissue', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into lien_waivers
          (id, org_id, waiver_number, direction, party_id, project_id, waiver_type, status, through_date, amount, currency, created_by, updated_by)
        values (${draftWaiver}, ${org.orgId}, 'LW-LEG-3', 'received', ${partyId}, ${projectId}, 'conditional_progress',
                'draft', '2020-01-31', '1000.00', 'CAD', ${actorId}, ${actorId})`);

      // -- 0274: a completion frozen from the live schedule (marked), a
      // -- post-upgrade completion, and an uncompleted document (unmarked).
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into hrm_retention_schedules (id, org_id, category_key, retain_years, from_event, action, is_active)
        values (${scheduleId}, ${org.orgId}, 'legacy-contracts', 7, 'completion', 'anonymize', true)`);
      await db.execute(sql`
        insert into hrm_documents
          (id, org_id, category_key, title, status, completed_at, retention_rule_id, retain_until, retention_action,
           created_at, updated_at)
        values (${legacyDoc}, ${org.orgId}, 'legacy-contracts', 'Legacy agreement', 'signed', ${LEGACY_DAY}::timestamptz,
                ${scheduleId}, '2027-01-15', 'anonymize', ${LEGACY_DAY}::timestamptz, ${LEGACY_DAY}::timestamptz)`);
      await db.execute(sql`
        insert into hrm_documents
          (id, org_id, category_key, title, status, completed_at, retention_rule_id, retain_until, retention_action)
        values (${freshDoc}, ${org.orgId}, 'legacy-contracts', 'Fresh agreement', 'signed', now(),
                ${scheduleId}, '2033-01-15', 'anonymize')`);
      await db.execute(sql`
        insert into hrm_documents
          (id, org_id, category_key, title, status, retention_rule_id, retention_action)
        values (${openDoc}, ${org.orgId}, 'legacy-contracts', 'Open agreement', 'sent', ${scheduleId}, 'anonymize')`);

      // -- 0293: a posted count with a duplicate subject (both lines marked)
      // -- and a draft count with duplicates (unmarked).
      const postedCount = randomUUID();
      const draftCount = randomUUID();
      const cleanCount = randomUUID();
      for (const [id, status] of [[postedCount, 'posted'], [draftCount, 'draft'], [cleanCount, 'posted']] as const) {
        await db.execute(sql`
          insert into stock_counts (id, org_id, location_id, subsidiary_id, status, counted_on)
          values (${id}, ${org.orgId}, ${org.locationId}, ${org.subsidiaryId}, ${status}, '2020-01-10')`);
      }
      await db.execute(sql`
        insert into stock_count_lines (id, org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
        values (${dupA}, ${org.orgId}, ${postedCount}, ${org.items.fifo}, ${org.stockLocationId}, null, '10', '9'),
               (${dupB}, ${org.orgId}, ${postedCount}, ${org.items.fifo}, ${org.stockLocationId}, null, '10', '9')`);
      await db.execute(sql`
        insert into stock_count_lines (org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
        values (${org.orgId}, ${draftCount}, ${org.items.fifo}, ${org.stockLocationId}, null, '10', '9'),
               (${org.orgId}, ${draftCount}, ${org.items.fifo}, ${org.stockLocationId}, null, '10', '9')`);
      await db.execute(sql`
        insert into stock_count_lines (org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
        values (${org.orgId}, ${cleanCount}, ${org.items.fifo}, ${org.stockLocationId}, null, '10', '9')`);

      // -- 0299: a posted negative count (marked) and a draft negative
      // -- (unmarked).
      const negPosted = randomUUID();
      const negDraft = randomUUID();
      for (const [id, status] of [[negPosted, 'posted'], [negDraft, 'draft']] as const) {
        await db.execute(sql`
          insert into stock_counts (id, org_id, location_id, subsidiary_id, status, counted_on)
          values (${id}, ${org.orgId}, ${org.locationId}, ${org.subsidiaryId}, ${status}, '2020-01-10')`);
      }
      await db.execute(sql`
        insert into stock_count_lines (id, org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
        values (${negLine}, ${org.orgId}, ${negPosted}, ${org.items.fifo}, ${org.stockLocationId}, null, '10', '-1')`);
      await db.execute(sql`
        insert into stock_count_lines (org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
        values (${org.orgId}, ${negDraft}, ${org.items.fifo}, ${org.stockLocationId}, null, '10', '-1')`);

      await db.execute(sql.raw(migrationSql));

    // Same pinned transaction: a nested withBypass would open a second
    // connection and wait forever on this transaction's locks.
    const rows = await provenance(org.orgId);
    const marked = new Map(rows.map((row) => [`${row.migration}/${row.table_name}/${row.row_id}`, row.note]));
    assert.equal(rows.length, 8, `expected 8 legacy rows, got ${JSON.stringify(rows.map((r) => [r.migration, r.row_id]))}`);

    const expectMarked = (migration: string, table: string, rowId: string, note: string) => {
      assert.equal(
        marked.get(`${migration}/${table}/${rowId}`),
        note,
        `${migration} should record ${rowId}`,
      );
    };
    const expectAbsent = (table: string, rowId: string) => {
      assert.ok(
        ![...marked.keys()].some((key) => key.endsWith(`/${table}/${rowId}`)),
        `${table} ${rowId} must stay unmarked`,
      );
    };
    expectMarked(
      "0297_recognition_rule_versions", "recognition_rules", oldRule,
      "rule predates versioning; pre-upgrade policy edits were made in place so the pinned row may not be the policy its obligations were built under — unverified legacy",
    );
    expectAbsent("recognition_rules", staleRule);
    expectAbsent("recognition_rules", freshRule);
    expectMarked(
      "0298_item_rate_version_profile_pins", "item_rate_version_profiles", oldPin,
      "rate pin backfilled from the live profile; governing policy at version time unrecorded — unverified legacy",
    );
    expectAbsent("item_rate_version_profiles", newPin);
    expectMarked(
      "0292_lien_waiver_executed_snapshot", "lien_waivers", signedWaiver,
      "executed before execution snapshots existed; print image not frozen at signing — unverified legacy",
    );
    expectMarked(
      "0292_lien_waiver_executed_snapshot", "lien_waivers", voidWaiver,
      "executed before execution snapshots existed; print image not frozen at signing — unverified legacy",
    );
    expectAbsent("lien_waivers", draftWaiver);
    expectMarked(
      "0274_retention_action_completion_snapshot", "hrm_documents", legacyDoc,
      "retention action inherited from the live schedule; governing action at completion unrecorded — unverified legacy",
    );
    expectAbsent("hrm_documents", freshDoc);
    expectAbsent("hrm_documents", openDoc);
    expectMarked(
      "0293_stock_count_line_subject_unique", "stock_count_lines", dupA,
      "duplicate subject posted before the 0293 guard; double-posted variance stands — grandfathered legacy",
    );
    expectMarked(
      "0293_stock_count_line_subject_unique", "stock_count_lines", dupB,
      "duplicate subject posted before the 0293 guard; double-posted variance stands — grandfathered legacy",
    );
    expectMarked(
      "0299_stock_count_line_counted_nonnegative", "stock_count_lines", negLine,
      "negative count posted before the 0299 guard; phantom variance stands — grandfathered legacy",
    );

    // The registry is tenant-isolated at the storage boundary, like every
    // other org table: RLS on, forced past the table owner, with a policy.
    const guard = (await (db.execute<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(sql`
      select c.relrowsecurity, c.relforcerowsecurity, count(p.policyname)::text as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_policies p on p.schemaname = 'public' and p.tablename = 'upgrade_legacy_provenance'
       where n.nspname = 'public' and c.relname = 'upgrade_legacy_provenance'
       group by c.relrowsecurity, c.relforcerowsecurity
    `))).rows[0]!;
    assert.equal(guard.relrowsecurity, true);
    assert.equal(guard.relforcerowsecurity, true);
    assert.equal(guard.policies, "1");

    // Re-running changes nothing: every legacy row collides on its key.
    await db.execute(sql.raw(migrationSql));
    assert.deepEqual(await provenance(org.orgId), rows);

        throw ROLLBACK;
      }),
    ).catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
