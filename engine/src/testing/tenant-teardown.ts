import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { deleteSandbox } from "../sandbox/lifecycle.ts";
import { deletionOrder, loadCatalog } from "../sandbox/catalog.ts";
import { SIM_ORG_PREFIX } from "../sim/db-guard.ts";

// Teardown discovers every org-owned table and verifies that none retain tenant rows.

export type TeardownTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SQL_IDENT = /^[a-z_][a-z0-9_]*$/;

export function qualified(table: string) {
  if (!SQL_IDENT.test(table)) throw new Error(`unsafe table identifier: ${table}`);
  return sql.raw(`public."${table}"`);
}

/** Set transaction-local flags required by the disposable-tenant deletion guards. */
export async function setTeardownGucs(tx: TeardownTx): Promise<void> {
  await tx.execute(sql`
    select set_config('openbooks.amend', 'on', true),
           set_config('openbooks.sandbox_wipe', 'on', true),
           set_config('app.bypass_rls', 'on', true)`);
}

/** Every base table in public that carries an org_id column. */
export async function listOrgIdTables(): Promise<string[]> {
  const result = await db.execute<{ tableName: string }>(
    sql`
    select c.table_name as "tableName"
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'org_id'
       and t.table_type = 'BASE TABLE'
     order by c.table_name`,
    "objects",
  );
  return result.map((r) => r.tableName);
}

/** Remove a test-owned organization with its built-in configuration. */
export async function deleteBareOrg(orgId: string): Promise<void> {
  const seeded = await orgRowCounts(orgId);
  const order = deletionOrder(await loadCatalog());
  await withBypassContext(() =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('openbooks.sandbox_wipe', 'on', true), set_config('openbooks.migration', 'on', true)`,
      );
      await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
      for (const table of order) {
        if (seeded[table])
          await tx.execute(sql`delete from ${sql.identifier(table)} where org_id = ${orgId}`);
      }
      await tx.execute(sql`delete from orgs where id = ${orgId}`);
    }),
  );
}

export async function orgRowCounts(orgId: string): Promise<Record<string, number>> {
  // Escape any ambient pinned transaction (see dropScratchOrg): a verification
  // that reads through a caller's uncommitted transaction reports whatever the
  // caller has staged, not what the database durably holds.
  return withBypassContext(() => orgRowCountsCommitted(orgId));
}

async function orgRowCountsCommitted(orgId: string): Promise<Record<string, number>> {
  const tables = await listOrgIdTables();
  const counts: Record<string, number> = {};
  await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    const union = sql.join(
      [
        sql`select 'orgs'::text as "tableName", count(*)::int as n from orgs where id = ${orgId}`,
        ...tables.map(
          (t) =>
            sql`select ${t}::text as "tableName", count(*)::int as n from ${qualified(t)} where org_id = ${orgId}`,
        ),
      ],
      sql` union all `,
    );
    const result = await tx.execute<{ tableName: string; n: number }>(union, "objects");
    for (const row of result) if (Number(row.n) > 0) counts[row.tableName] = Number(row.n);
  });
  return counts;
}

/** Delete interlocked document, journal, time, and inventory records child-first. */
export const CORE_A = [
  // Stored value before journals, parties and programs: entries reference
  // journal entries, accounts reference programs and parties.
  "stored_value_entries",
  "stored_value_accounts",
  "stored_value_programs",
  // Physical operation headers and movements share deferred provenance links.
  "assembly_disassemblies",
  "inventory_provisional_costs",
  "cost_layers",
  "inventory_movements",
  // The current missing-count movement and serial identity share a deferred
  // reference; remove both in this transaction before validating the cycle.
  "serials",
  // Capitalized contract costs, children first: amortization rows reference
  // assets, periods and journal entries; assets reference revenue contracts;
  // policies reference accounts.
  "contract_cost_amortization",
  "contract_cost_assets",
  "contract_cost_policies",
  "recognition_schedules",
  "performance_obligations",
  "revenue_contracts",
  "document_lines",
  "time_entries",
  "journal_lines",
  "journal_entries",
  "documents",
];

/** Tx B: the master-data parents everything above referenced, children first. */
const CORE_B = [
  "lots",
  "stock_locations",
  "locations",
  "projects",
  // Projects pin profile versions; the profile's deferred current-version
  // reference permits both profile parents to leave in this same transaction.
  "operating_profile_scopes",
  "operating_profile_versions",
  "operating_profiles",
  "project_types",
  "time_types",
  // equipment_units.charge_item_id references items.
  "equipment_units",
  "item_rate_versions",
  "item_rate_books",
  "item_family_options",
  "items",
  // Variants reference families with RESTRICT, so families go after items.
  "item_families",
  "recognition_rules",
  // payment_cards.holder_party_id references parties.
  "payment_cards",
  "parties",
  "tax_groups",
  "tax_codes",
  "tax_jurisdictions",
  "departments",
  "asset_categories",
  "depreciation_methods",
  "accounting_periods",
  "accounting_books",
  "fiscal_calendars",
  "accounts",
  "subsidiaries",
  // created_by references make users a parent of nearly everything above.
  "users",
];

/** Guards that must be disabled transactionally while disposable evidence is removed. */
export const GUARDED_EVIDENCE: { table: string; trigger: string }[] = [
  // Children leave before their retained financial policy and transaction parents.
  { table: "journal_reversal_instructions", trigger: "journal_reversal_instruction_guard" },
  { table: "gl_audit_number_assignments", trigger: "gl_audit_number_assignments_immutable" },
  { table: "gl_audit_number_policies", trigger: "gl_audit_number_policies_immutable" },
  { table: "project_loss_policies", trigger: "project_loss_policies_immutable" },
  { table: "expense_fx_policies", trigger: "expense_fx_policies_immutable" },
  // Equity history leaves child-first: runs and events before securities,
  // securities before rounds and plans, everything before its share class.
  { table: "equity_action_requests", trigger: "equity_action_requests_immutable" },
  { table: "equity_position_movements", trigger: "equity_position_movements_immutable" },
  {
    table: "equity_instrument_line_attributions",
    trigger: "equity_instrument_line_attributions_immutable",
  },
  {
    table: "equity_compensation_run_releases",
    trigger: "equity_compensation_run_releases_immutable",
  },
  { table: "equity_compensation_run_lines", trigger: "equity_compensation_run_lines_immutable" },
  { table: "equity_interest_run_lines", trigger: "equity_interest_run_lines_immutable" },
  { table: "equity_interest_runs", trigger: "equity_interest_runs_immutable" },
  { table: "equity_security_amendments", trigger: "equity_security_amendments_immutable" },
  { table: "equity_compensation_runs", trigger: "equity_compensation_runs_immutable" },
  { table: "equity_security_events", trigger: "equity_security_events_immutable" },
  { table: "equity_securities", trigger: "equity_securities_immutable" },
  { table: "equity_round_amendments", trigger: "equity_round_amendments_immutable" },
  { table: "equity_financing_rounds", trigger: "equity_financing_rounds_immutable" },
  { table: "equity_plan_reserve_changes", trigger: "equity_plan_reserve_changes_immutable" },
  { table: "equity_plans", trigger: "equity_plans_immutable" },
  { table: "equity_splits", trigger: "equity_splits_immutable" },
  { table: "equity_class_amendments", trigger: "equity_class_amendments_immutable" },
  { table: "equity_share_classes", trigger: "equity_share_classes_immutable" },
  { table: "equity_account_policies", trigger: "equity_account_policies_immutable" },
  { table: "account_translation_policies", trigger: "account_translation_policies_immutable" },
  {
    table: "subsidiary_accounting_preferences",
    trigger: "subsidiary_accounting_preferences_immutable",
  },
  { table: "segment_balancing_policies", trigger: "segment_balancing_policies_immutable" },
  { table: "recognition_control_events", trigger: "recognition_controls_immutable" },
  { table: "subscription_renewal_occurrences", trigger: "renewal_occurrence_guard" },
  { table: "subscription_renewal_policies", trigger: "renewal_policy_guard" },
  { table: "rebate_settlement_reversals", trigger: "rebate_reversals_immutable" },
  { table: "rebate_claims", trigger: "rebate_claim_guard" },
  { table: "rebate_accruals", trigger: "rebate_accruals_immutable" },
  { table: "rebate_cost_attestations", trigger: "rebate_costs_immutable" },
  { table: "rebate_agreements", trigger: "rebate_agreement_guard" },
  { table: "fair_value_prices", trigger: "fair_value_used_policy" },
  // Approved plans are immutable even during sandbox wipes. Delete cells
  // before headers, retaining the same scoped, transactional guard handling.
  { table: "budget_lines", trigger: "budget_line_guard" },
  { table: "budget_scenarios", trigger: "budget_scenario_guard" },
  { table: "field_ticket_labor_lines", trigger: "field_ticket_labor_line_immutable" },
  { table: "field_ticket_labor_snapshots", trigger: "field_ticket_labor_snapshot_retention" },
  { table: "field_ticket_signatures", trigger: "field_ticket_signature_immutable" },
  // Dunning delivery evidence is append-only with no sandbox-wipe escape;
  // its trigger honors only the session bypass flag, which pooled
  // connections never carry, so scratch reset/drop disables it here.
  { table: "dunning_log", trigger: "dunning_log_no_mutate" },
  // Application idempotency evidence is immutable until expiry with no
  // sandbox-wipe escape either; same scoped disable for the one transaction.
  { table: "application_idempotency_keys", trigger: "application_idempotency_guard" },
  {
    table: "project_financial_profile_versions",
    trigger: "project_financial_profile_version_guard",
  },
  // Amortization rows are immutable posted history with no sandbox-wipe
  // escape; scratch reset/drop disables the guard for the one transaction.
  { table: "contract_cost_amortization", trigger: "contract_cost_amortization_immutable_trigger" },
  // Stored-value entries are immutable posted history; their guard honors only
  // full teardown's org flag, so pooled reset disables it for the one
  // transaction (deleting a card cascades into its entries).
  { table: "stored_value_entries", trigger: "stored_value_entries_immutable_trigger" },
  // Quota history deletes only inside a native maintenance sandbox wipe, which
  // requires a superuser or BYPASSRLS login; pooled reset runs as the plain
  // test login. Disable the guard for the one transaction, as for other evidence.
  { table: "crm_sales_quotas", trigger: "sales_quota_version_guard" },
];

/** Disable audit writers only during the delete pass that would create new audit rows. */
export const AUDIT_WRITER_TRIGGERS: { table: string; trigger: string }[] = [
  {
    table: "payroll_work_location_allocations",
    trigger: "payroll_work_location_allocation_audit",
  },
];

type DisposableOrgKind = "scratch" | "sim";

function disposableOrgPredicate(kind: DisposableOrgKind) {
  return kind === "scratch"
    ? sql`name like 'Scratch %'`
    : sql`name like ${SIM_ORG_PREFIX + "%"} and settings->'simHarness' = 'true'::jsonb`;
}

/** Break the project/quote reference cycle before deleting disposable tenant rows. */
export async function clearDisposableProjectAwardReferences(
  tx: TeardownTx,
  orgId: string,
): Promise<void> {
  await tx.execute(sql`
    update projects set awarded_from_document_id = null, awarded_at = null, awarded_by = null
     where org_id = ${orgId} and awarded_from_document_id is not null`);
}

/** Recheck identity under a row lock in EVERY mutating transaction. A rename
 * or tag revocation between committed passes must stop the next pass before
 * any tenant data or trigger changes. The policies are intentionally disjoint. */
export async function guardTeardownTransaction(
  tx: TeardownTx,
  orgId: string,
  kind: DisposableOrgKind,
): Promise<void> {
  await setTeardownGucs(tx);
  const r = await tx.execute(
    sql`
    select id from orgs where id = ${orgId} and ${disposableOrgPredicate(kind)} for update`,
    "objects",
  );
  if (r.length !== 1)
    throw new Error(
      `dropDisposableOrg refused: org ${orgId} no longer satisfies the ${kind} identity guard`,
    );
}

/** Delete a table set in one transaction and return per-table failures. */
async function bulkDeletePass(
  orgId: string,
  tables: string[],
  kind: DisposableOrgKind,
): Promise<{ table: string; error: string }[]> {
  for (const t of tables) {
    if (!SQL_IDENT.test(t)) throw new Error(`unsafe table identifier: ${t}`);
  }
  return await db.transaction(async (tx) => {
    await guardTeardownTransaction(tx, orgId, kind);
    await tx.execute(sql`
      select set_config('openbooks.teardown_org', ${orgId}, true),
             set_config('openbooks.teardown_tables', ${tables.join(",")}, true)`);
    await tx.execute(sql`
      create temp table if not exists scratch_teardown_failures
        (table_name text, error text) on commit drop`);
    await tx.execute(sql`
      do $teardown$
      declare
        v_org uuid := current_setting('openbooks.teardown_org')::uuid;
        v_table text;
      begin
        foreach v_table in array string_to_array(current_setting('openbooks.teardown_tables'), ',') loop
          begin
            execute format('delete from public.%I where org_id = $1', v_table) using v_org;
          exception when others then
            insert into scratch_teardown_failures values (v_table, sqlerrm);
          end;
        end loop;
      end
      $teardown$`);
    const r = await tx.execute<{ table: string; error: string }>(
      sql`
      select table_name as "table", error from scratch_teardown_failures`,
      "objects",
    );
    return r;
  });
}

/** Retry blocked tables and isolate commit-time constraint failures by table. */
async function genericDeletePasses(
  orgId: string,
  tables: string[],
  kind: DisposableOrgKind,
): Promise<{ remaining: string[]; errors: Map<string, unknown> }> {
  let remaining = tables;
  const errors = new Map<string, unknown>();
  for (let pass = 0; pass < 10 && remaining.length > 0; pass++) {
    let failed: string[];
    try {
      const failures = await bulkDeletePass(orgId, remaining, kind);
      failed = failures.map((f) => f.table);
      for (const t of remaining) errors.delete(t);
      for (const f of failures) errors.set(f.table, new Error(f.error));
    } catch {
      failed = [];
      for (const t of remaining) {
        try {
          await db.transaction(async (tx) => {
            await guardTeardownTransaction(tx, orgId, kind);
            await tx.execute(sql`delete from ${qualified(t)} where org_id = ${orgId}`);
          });
          errors.delete(t);
        } catch (e) {
          failed.push(t);
          errors.set(t, e);
        }
      }
    }
    if (failed.length === remaining.length) break; // no progress
    remaining = failed;
  }
  return { remaining, errors };
}

export const RETAINED_CABINET_FILE_SOURCES = [
  "payroll_roe_issued_event_sources",
  "payroll_roe_subsequent_service_sources",
  "payroll_roe_line_evidence",
  "payroll_roe_historical_periods",
  "payroll_opening_employer_authorities",
] as const;

/** Remove approved bindings before protected source files in the qualified tenant. */
export async function deleteQualifiedCabinetFixtureSources(
  tx: TeardownTx,
  orgId: string,
  present: ReadonlySet<string>,
): Promise<void> {
  // Identity certificates retain exact Cabinet versions and must leave before
  // their files under the already-qualified disposable-tenant wipe authority.
  if (present.has("field_ticket_source_certifications")) {
    await tx.execute(sql`delete from field_ticket_source_certifications where org_id=${orgId}`);
  }
  for (const [table, trigger] of [
    ["historical_translation_layers", "historical_translation_layer_guard"],
    ["historical_translation_contributions", "historical_translation_basis_guard"],
    ["payroll_ca_opening_reporting_allocations", "payroll_ca_opening_reporting_allocation_guard"],
    ["payroll_ca_opening_reporting_authorities", "payroll_ca_opening_reporting_authority_guard"],
    ["payroll_opening_levy_source_allocations", "payroll_opening_levy_source_allocation_guard"],
    ["payroll_opening_levy_source_authorities", "payroll_opening_levy_source_authority_guard"],
  ] as const) {
    if (!present.has(table)) continue;
    const rows = await tx.execute(
      sql`select 1 from ${qualified(table)} where org_id=${orgId} limit 1`,
      "objects",
    );
    if (!rows.length) continue;
    await tx.execute(sql.raw(`alter table public."${table}" disable trigger ${trigger}`));
    await tx.execute(sql`delete from ${qualified(table)} where org_id=${orgId}`);
    await tx.execute(sql.raw(`alter table public."${table}" enable trigger ${trigger}`));
  }
}

/** Remove a named scratch tenant through committed passes and verify every row is gone. */
export async function dropScratchOrgEscaped(orgId: string): Promise<void> {
  return dropDisposableOrgEscaped(orgId, "scratch");
}

/** Remove a SIM tenant using its name and tag identity guard. */
export async function dropSimOrg(orgId: string): Promise<void> {
  return withBypassContext(() => dropDisposableOrgEscaped(orgId, "sim"));
}

async function dropDisposableOrgEscaped(orgId: string, kind: DisposableOrgKind): Promise<void> {
  const operation = kind === "scratch" ? "dropScratchOrg" : "dropSimOrg";
  // Hard scope guard. If the orgs row is gone the wipe already completed
  // (orgs is deleted last); if it exists under any other name, refuse.
  const orgRow = await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    const r = await tx.execute<{ name: string; allowed: boolean }>(
      sql`
      select name, coalesce((${disposableOrgPredicate(kind)}), false) as allowed from orgs where id = ${orgId}`,
      "objects",
    );
    return r[0];
  });
  if (!orgRow) {
    // "Already deleted" must be proven, not assumed: if the org row is merely
    // invisible (RLS misconfiguration) or a previous run died between deleting
    // orgs and finishing, silent success here is how leaks go unnoticed.
    const leftovers = await orgRowCounts(orgId);
    if (Object.keys(leftovers).length > 0) {
      throw new Error(
        `${operation}(${orgId}): orgs row is not visible but org-scoped rows remain ` +
          `(${JSON.stringify(leftovers)}) — refusing to report success`,
      );
    }
    return;
  }
  if (!orgRow.allowed) {
    throw new Error(
      kind === "scratch"
        ? `dropScratchOrg refused: org ${orgId} is named ${JSON.stringify(orgRow.name)}, not 'Scratch %'`
        : `dropSimOrg refused: org ${orgId} must have the SIM name prefix and simHarness=true tag`,
    );
  }

  const orgTables = await listOrgIdTables();
  const present = new Set(orgTables);
  const coreA = CORE_A.filter((t) => present.has(t));
  const coreB = CORE_B.filter((t) => present.has(t));
  const core = new Set([...coreA, ...coreB]);

  // Prepare the sandbox identity, users, movements, and linked evidence before deletion.
  await db.transaction(async (tx) => {
    await guardTeardownTransaction(tx, orgId, kind);
    await tx.execute(
      sql`update orgs set env_kind = 'sandbox' where id = ${orgId} and ${disposableOrgPredicate(kind)}`,
    );
    // Password-reset tokens predate tenant scoping: they carry only user_id
    // and intentionally have no FK, so deleting users would otherwise leave
    // an orphaned credential record behind in the global auth tables.
    await tx.execute(sql`delete from auth_password_resets
      where user_id in (select id from users where org_id = ${orgId})`);
    await tx.execute(sql`update users set is_active = false where org_id = ${orgId}`);
    await tx.execute(
      sql`update inventory_movements set status = 'pending' where org_id = ${orgId} and status = 'posted'`,
    );
    await clearDisposableProjectAwardReferences(tx, orgId);
    // Remove append-only capture rows before protected source files in this transaction.
    const captureItems = await tx.execute(
      sql`select 1 from ap_capture_items where org_id = ${orgId} limit 1`,
      "objects",
    );
    if (captureItems.length > 0) {
      for (const [table, trigger] of [
        ["ap_capture_fields", "ap_capture_fields_append_only"],
        ["ap_capture_runs", "ap_capture_runs_immutable"],
        ["ap_capture_corrections", "ap_capture_corrections_append_only"],
        ["ap_capture_events", "ap_capture_events_append_only"],
      ] as const) {
        await tx.execute(sql.raw(`alter table public."${table}" disable trigger ${trigger}`));
        await tx.execute(sql`delete from ${qualified(table)} where org_id = ${orgId}`);
        await tx.execute(sql.raw(`alter table public."${table}" enable trigger ${trigger}`));
      }
      await tx.execute(sql`delete from ap_capture_items where org_id = ${orgId}`);
    }
    // Clear protected bank-file rows before blobs, disabling only their unconditional guards.
    const bankFiles = await tx.execute(
      sql`select 1 as x from pay_run_bank_files where org_id = ${orgId} limit 1`,
      "objects",
    );
    const hasBankFiles = bankFiles.length > 0;
    if (hasBankFiles) {
      await tx.execute(
        sql.raw(
          `alter table public."pay_run_bank_files" disable trigger pay_run_bank_file_immutable`,
        ),
      );
      await tx.execute(
        sql.raw(`alter table public."file_blobs" disable trigger payroll_bank_file_blob_immutable`),
      );
      await tx.execute(sql`delete from pay_run_bank_files where org_id = ${orgId}`);
    }
    // Unpaid holiday rights retain exact Cabinet versions. Remove their
    // disposable-org claims before deleting the protected source versions.
    for (const table of [
      "pay_run_holiday_allocations",
      "payroll_holiday_occurrences",
      "payroll_holiday_obligations",
    ]) {
      if (present.has(table))
        await tx.execute(sql`delete from ${qualified(table)} where org_id=${orgId}`);
    }
    // Retained reporting and opening certificates pin Cabinet versions. The
    // guarded disposable-org transaction removes bindings before their sources.
    await deleteQualifiedCabinetFixtureSources(tx, orgId, present);
    for (const table of RETAINED_CABINET_FILE_SOURCES) {
      if (present.has(table))
        await tx.execute(sql`delete from ${qualified(table)} where org_id=${orgId}`);
    }
    await tx.execute(sql`delete from file_blobs where version_id in
      (select v.id from file_versions v join files f on f.id = v.file_id where f.org_id = ${orgId})`);
    await tx.execute(
      sql`delete from file_versions where file_id in (select id from files where org_id = ${orgId})`,
    );
    if (hasBankFiles) {
      await tx.execute(
        sql.raw(`alter table public."file_blobs" enable trigger payroll_bank_file_blob_immutable`),
      );
      await tx.execute(
        sql.raw(
          `alter table public."pay_run_bank_files" enable trigger pay_run_bank_file_immutable`,
        ),
      );
    }
    await tx.execute(
      sql`delete from tax_group_members where tax_group_id in (select id from tax_groups where org_id = ${orgId})`,
    );
  });

  // Disable each unconditional evidence guard only for its transaction-scoped delete.
  for (const { table, trigger } of [...GUARDED_EVIDENCE, ...AUDIT_WRITER_TRIGGERS]) {
    if (!present.has(table)) continue;
    if (!SQL_IDENT.test(trigger)) throw new Error(`unsafe trigger identifier: ${trigger}`);
    await db.transaction(async (tx) => {
      await guardTeardownTransaction(tx, orgId, kind);
      const r = await tx.execute(
        sql`select 1 as x from ${qualified(table)} where org_id = ${orgId} limit 1`,
        "objects",
      );
      if (r.length === 0) return;
      await tx.execute(sql.raw(`alter table public."${table}" disable trigger ${trigger}`));
      await tx.execute(sql`delete from ${qualified(table)} where org_id = ${orgId}`);
      await tx.execute(sql.raw(`alter table public."${table}" enable trigger ${trigger}`));
    });
  }

  // Break the deferrable payment schedule/run cycle before generic deletes.
  await db.transaction(async (tx) => {
    await guardTeardownTransaction(tx, orgId, kind);
    await tx.execute(sql`update payment_schedules
      set last_payment_run_id = null where org_id = ${orgId}`);
  });

  // Delete non-core tables first, then retry their parents after removing the core.
  let { remaining } = await genericDeletePasses(
    orgId,
    orgTables.filter((t) => !core.has(t)),
    kind,
  );

  // Tx A — the interlocked heavy core, children first. time_entries ↔
  // document_lines cross-reference each other (invoiced_by_line_id /
  // time_entry_id), so null the time side, then delete lines before entries.
  await db.transaction(async (tx) => {
    await guardTeardownTransaction(tx, orgId, kind);
    // Mark this transaction as the org's teardown: storage guards that
    // refuse ordinary rewrites (stored-value entries) let this tx remove the
    // doomed org's rows. Transaction-local, never visible outside teardown.
    await tx.execute(sql`select set_config('openbooks.teardown_org', ${orgId}, true)`);
    // Defer the specific consumed-time and rework references until their rows leave.
    await tx.execute(sql`set constraints time_entries_invoiced_by_line_id_fkey, time_entries_cost_journal_entry_id_fkey,
      mfg_receipt_rework_source_fk deferred`);
    await tx.execute(sql`update time_entries
      set invoiced_by_line_id = null, cost_journal_entry_id = null
      where org_id = ${orgId} and production_consumed_operation_id is null`);
    await tx.execute(sql`delete from inventory_inspections where org_id = ${orgId}`);
    for (const t of coreA) {
      if (t === "journal_entries") {
        // Defer only the document-to-journal links for this interlocked delete pass.
        await tx.execute(
          sql`set constraints documents_posted_entry_id_fkey, documents_reversal_entry_id_fkey deferred`,
        );
      }
      await tx.execute(sql`delete from ${qualified(t)} where org_id = ${orgId}`);
    }
    await tx.execute(sql`delete from mfg_wo_operations where org_id = ${orgId} and work_order_id in
      (select id from mfg_work_orders where org_id = ${orgId} and receipt_rework_inspection_id is not null)`);
    await tx.execute(
      sql`delete from mfg_work_orders where org_id = ${orgId} and receipt_rework_inspection_id is not null`,
    );
  });

  // Anything that was still blocked (e.g. parents of inventory_movements like
  // transfer_order_lines) unblocks once the core is gone.
  if (remaining.length > 0) {
    const retry = await genericDeletePasses(orgId, remaining, kind);
    remaining = retry.remaining;
    if (remaining.length > 0) {
      const detail = remaining
        .map(
          (t) =>
            `${t}: ${retry.errors.get(t) instanceof Error ? (retry.errors.get(t) as Error).message : String(retry.errors.get(t))}`,
        )
        .join("; ");
      throw new Error(`${operation}(${orgId}) could not clear tables — ${detail}`);
    }
  }

  // Tx B — master-data parents, then the org row itself (name-guarded again).
  await db.transaction(async (tx) => {
    await guardTeardownTransaction(tx, orgId, kind);
    for (const t of coreB) {
      await tx.execute(sql`delete from ${qualified(t)} where org_id = ${orgId}`);
    }
    await tx.execute(sql`delete from orgs where id = ${orgId} and ${disposableOrgPredicate(kind)}`);
  });

  // Verify: zero rows across every org_id table (and no orgs row). A leak
  // here means the schema grew a shape this teardown doesn't understand —
  // fail loudly instead of littering the shared database.
  const leftovers = await orgRowCounts(orgId);
  if (Object.keys(leftovers).length > 0) {
    throw new Error(`${operation}(${orgId}) left rows behind: ${JSON.stringify(leftovers)}`);
  }
}

/** Delete a marked sample-company clone through the native sandbox lifecycle and verify removal. */
export async function dropSampleCloneOrg(orgId: string): Promise<void> {
  return withBypassContext(async () => {
    const row = (
      await db.execute<{ name: string; envKind: string; isSample: boolean }>(
        sql`
      select name, env_kind as "envKind",
             ((settings ? 'sampleCompany')
              or (settings ? 'sampleTemplatePromotion')
              or coalesce((settings->>'simHarness')::boolean, false)) as "isSample"
        from orgs where id = ${orgId}`,
        "objects",
      )
    )[0];
    if (!row) {
      throw new Error(
        `dropSampleCloneOrg(${orgId}): orgs row is gone; refusing to report an unverified delete as success`,
      );
    }
    if (!row.isSample) {
      throw new Error(
        `dropSampleCloneOrg refused: org ${orgId} is named ${JSON.stringify(row.name)} and carries no sample-company marker`,
      );
    }
    if (row.envKind !== "preview" && row.envKind !== "sandbox") {
      throw new Error(
        `dropSampleCloneOrg refused: org ${orgId} has env_kind ${JSON.stringify(row.envKind)}, expected 'preview' or 'sandbox'`,
      );
    }
    if (row.envKind === "preview") {
      await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
    }
    const sandboxRows = await db.execute<{ id: string }>(
      sql`
      select id from sandboxes where org_id = ${orgId}`,
      "objects",
    );
    if (sandboxRows.length !== 1) {
      throw new Error(
        `dropSampleCloneOrg(${orgId}): expected exactly one sandboxes row, found ${sandboxRows.length}`,
      );
    }
    await deleteSandbox(sandboxRows[0]!.id);
    const remaining = (
      await db.execute<{ n: number }>(
        sql`
      select count(*)::int as n from orgs where id = ${orgId}`,
        "objects",
      )
    )[0]!.n;
    if (remaining !== 0) {
      throw new Error(`dropSampleCloneOrg(${orgId}): orgs row survived deleteSandbox`);
    }
  });
}
