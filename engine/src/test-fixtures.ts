import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "./db.ts";

/**
 * DB test fixtures — a disposable scratch org with the full accounting spine a
 * subledger integration test needs (book, subsidiary, open period, accounts,
 * inventory items + profiles, a BOM, and a revenue-recognition item/rule).
 *
 * The repository test command preloads `test-database-bypass.ts`, an explicit
 * test-process-only trusted boundary. Direct callers outside that runner must
 * create/remove fixtures inside `withBypass`, then exercise product behavior
 * in `withOrg`/`withOrgContext`. Unscoped application access remains denied.
 * dropScratchOrg tears everything down under `openbooks.amend = on` so it can
 * remove posted journal entries the kernel otherwise pins as immutable.
 */

export interface ScratchOrg {
  orgId: string;
  subsidiaryId: string;
  periodId: string;
  periodIds: string[];
  bookId: string;
  locationId: string;
  stockLocationId: string;
  stockLocationId2: string;
  accounts: Record<
    "invAsset" | "cogs" | "adjustment" | "clearing" | "freight" | "ar" | "ap" | "bank" | "revenue" | "deferred" | "recognized" | "fxGainLoss" | "taxInput" | "taxOutput" | "withholding",
    string
  >;
  items: Record<"fifo" | "movingAvg" | "standard" | "component" | "assembly" | "service", string>;
  recognitionRuleId: string;
  customerId: string;
  vendorId: string;
  /** a date inside the open period. */
  date: string;
}

export async function createScratchOrg(): Promise<ScratchOrg> {
  const orgId = randomUUID();
  const date = "2026-07-15";

  // CI loads the schema without the product seed. Financial fixtures still
  // need a valid ISO registry row before they can snapshot functional currency
  // onto time, labor rates, documents, or journal lines.
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('CAD', 'Canadian Dollar', 2)
    on conflict (code) do nothing`);

  await db.execute(sql`
    insert into orgs (id, name, base_currency, country, settings, env_kind)
    values (${orgId}, ${"Scratch " + orgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb, 'production')`);

  const fiscalCalendarId = randomUUID();
  await db.execute(sql`
    insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                  adjustment_period_enabled, is_default, is_active, config)
    values (${fiscalCalendarId}, ${orgId}, 'Default', 'monthly', 1, 1, 'UTC', false, true, true, '{}'::jsonb)`);

  // 12 consecutive monthly periods spanning the default recognition rule term.
  const periodIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const month = 7 + i;
    const year = 2026 + Math.floor((month - 1) / 12);
    const m = ((month - 1) % 12) + 1;
    const start = `${year}-${String(m).padStart(2, "0")}-01`;
    const endDays = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const end = `${year}-${String(m).padStart(2, "0")}-${String(endDays).padStart(2, "0")}`;
    const pid = randomUUID();
    periodIds.push(pid);
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${pid}, ${orgId}, ${year}, ${m}, ${`${year}-${String(m).padStart(2, "0")}`}, ${start}, ${end}, false, ${fiscalCalendarId})`);
  }

  const bookId = randomUUID();
  await db.execute(sql`
    insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${bookId}, ${orgId}, 'PRI', 'Primary', true, true, true)`);

  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subsidiaryId}, ${orgId}, 'Main Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);

  const locationId = randomUUID();
  await db.execute(sql`
    insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children)
    values (${locationId}, ${orgId}, 'HQ', true, '{}'::jsonb, true)`);
  const locationId2 = randomUUID();
  await db.execute(sql`
    insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children)
    values (${locationId2}, ${orgId}, 'DC', true, '{}'::jsonb, true)`);

  const stockLocationId = randomUUID();
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values (${stockLocationId}, ${orgId}, ${locationId}, 'MAIN', 'warehouse', true)`);
  const stockLocationId2 = randomUUID();
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values (${stockLocationId2}, ${orgId}, ${locationId2}, 'STAGE', 'warehouse', true)`);

  // Accounts.
  const acctDefs: [keyof ScratchOrg["accounts"], string, string, string][] = [
    ["invAsset", "1300", "Inventory Asset", "asset_current_other"],
    ["clearing", "2150", "Received Not Billed", "liability_current_other"],
    ["deferred", "2200", "Deferred Revenue", "liability_current_other"],
    ["ap", "2000", "Accounts Payable", "liability_payable"],
    ["ar", "1100", "Accounts Receivable", "asset_receivable"],
    ["bank", "1000", "Cash", "asset_bank"],
    ["cogs", "5000", "Cost of Goods Sold", "expense"],
    ["adjustment", "5100", "Inventory Adjustment", "expense"],
    ["freight", "5200", "Freight In", "expense"],
    ["revenue", "4000", "Revenue", "income"],
    ["recognized", "4010", "Recognized Revenue", "income"],
    ["fxGainLoss", "7010", "Realized FX Gain or Loss", "expense"],
    ["taxInput", "1250", "Recoverable Tax", "asset_current_other"],
    ["taxOutput", "2250", "Tax Payable", "liability_current_other"],
    ["withholding", "2260", "Withholding Payable", "liability_current_other"],
  ];
  const accounts = {} as ScratchOrg["accounts"];
  for (const [key, number, name, type] of acctDefs) {
    const id = randomUUID();
    accounts[key] = id;
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  }

  // Org control accounts (for document posting), with the payroll feature
  // gate open so DB-backed payroll suites exercise real runs (the product
  // default is off; scratch orgs exist only inside a single test's lifetime).
  await db.execute(sql`
    update orgs set settings = ${JSON.stringify({ features: { payroll: true }, controlAccounts: { ar: accounts.ar, ap: accounts.ap, bank: accounts.bank, fxRealizedGainLoss: accounts.fxGainLoss } })}::jsonb
     where id = ${orgId}`);

  // Items + inventory profiles.
  async function inventoryItem(name: string, method: "fifo" | "moving_average" | "standard", standardCost?: string): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
      values (${id}, ${orgId}, 'inventory', ${name}, false, true, '{}'::jsonb, 'billing', 'normal', ${accounts.revenue})`);
    await db.execute(sql`
      insert into item_inventory_profiles
        (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
         variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
      values (${randomUUID()}, ${orgId}, ${id}, ${method}, 'none', ${accounts.invAsset}, ${accounts.cogs}, ${accounts.adjustment},
              ${accounts.adjustment}, ${accounts.clearing}, ${standardCost ?? null}, 'ea', '{}'::jsonb)`);
    return id;
  }
  const items = {
    fifo: await inventoryItem("FIFO Widget", "fifo"),
    movingAvg: await inventoryItem("Avg Widget", "moving_average"),
    standard: await inventoryItem("Std Widget", "standard", "2.00"),
    component: await inventoryItem("Component", "fifo"),
    assembly: await inventoryItem("Assembly", "fifo"),
    service: randomUUID(),
  } as ScratchOrg["items"];

  // BOM: assembly needs 2 components.
  await db.execute(sql`
    insert into bom_components (id, org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
    values (${randomUUID()}, ${orgId}, ${items.assembly}, ${items.component}, '2', 0)`);

  // Revenue recognition rule + service item.
  const recognitionRuleId = randomUUID();
  await db.execute(sql`
    insert into recognition_rules
      (id, org_id, code, name, method, is_forecast, recognition_periods, start_date_source, end_date_source,
       period_offset, start_offset_days, initial_amount_percent, deferred_account_id, recognized_account_id, is_active)
    values (${recognitionRuleId}, ${orgId}, 'SL12', '12-month straight line', 'straight_line_even', false, 12,
            'obligation', 'term', 0, 0, '0', ${accounts.deferred}, ${accounts.recognized}, true)`);
  await db.execute(sql`
    insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation,
                       income_account_id, recognition_rule_id, deferred_account_id)
    values (${items.service}, ${orgId}, 'service', 'Annual Subscription', false, true, '{}'::jsonb, 'billing', 'normal',
            ${accounts.revenue}, ${recognitionRuleId}, ${accounts.deferred})`);

  const customerId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${customerId}, ${orgId}, 'customer', 'Acme Customer', true, '{}'::jsonb)`);

  const vendorId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${vendorId}, ${orgId}, 'vendor', 'Acme Vendor', true, '{}'::jsonb)`);

  return { orgId, subsidiaryId, periodId: periodIds[0]!, periodIds, bookId, locationId, stockLocationId, stockLocationId2, accounts, items, recognitionRuleId, customerId, vendorId, date };
}

export interface FlowActors {
  /** The document creator (submitter). */
  submitterId: string;
  /** Two independent approvers (for quorum any/all). */
  approver1Id: string;
  approver2Id: string;
  /** An org admin (canActOnGate via the admin role). */
  adminId: string;
  /** A user with no role in the org (for negative/authz tests). */
  outsiderId: string;
}

/** Create an active scratch user and its explicit role assignment atomically. */
export async function createScratchUser(
  orgId: string,
  name: string,
  roleKey: string,
  userId = randomUUID(),
): Promise<string> {
  await db.transaction(async (tx) => {
    const role = (await tx.execute<{ id: string }>(sql`
      insert into app_roles (org_id, key, name, is_built_in, permissions)
      values (${orgId}, ${roleKey}, ${roleKey.replaceAll('_', ' ')}, false, '[]'::jsonb)
      on conflict (org_id, key) do update set updated_at = now()
      returning id
    `));
    await tx.execute(sql`
      insert into users (id, org_id, email, name, password_hash, is_active)
      values (${userId}, ${orgId}, ${`u-${userId.slice(0, 8)}@scratch.test`}, ${name}, 'x', true)
    `);
    await tx.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      values (${orgId}, ${userId}, ${role.rows[0]!.id})
    `);
  });
  return userId;
}

/** Seed the users an approval-flow test needs. Passwords are placeholders. */
export async function seedFlowActors(orgId: string): Promise<FlowActors> {
  const mk = async (name: string, role: string): Promise<string> => {
    return createScratchUser(orgId, name, role);
  };
  return {
    submitterId: await mk("Submitter", "accountant"),
    approver1Id: await mk("Approver One", "approver"),
    approver2Id: await mk("Approver Two", "approver"),
    adminId: await mk("Admin", "admin"),
    outsiderId: await mk("Outsider", "viewer"),
  };
}

export type SeedAssignee =
  | { type: "user"; userId: string }
  | { type: "role"; role: string }
  | { type: "submitter" }
  | { type: "supervisor" };

/**
 * Seed an enabled on_submit approval flow: trigger → gate, with NO downstream
 * change_status node — so tests prove the ENGINE releases the document
 * deterministically (not an authored side-effect).
 */
export async function seedApprovalFlow(
  orgId: string,
  opts: {
    subjectKind: string;
    assignees: SeedAssignee[];
    mode: "any" | "all";
    preventSelfApproval?: boolean;
    gateTitle?: string;
  },
): Promise<{ flowId: string; gateNodeId: string }> {
  const flowId = randomUUID();
  const gateNodeId = "gate";
  const graph = {
    schemaVersion: 1,
    nodes: [
      { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      {
        id: gateNodeId,
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: {
            title: opts.gateTitle ?? "Approval",
            assignees: opts.assignees,
            mode: opts.mode,
            ...(opts.preventSelfApproval !== undefined
              ? { preventSelfApproval: opts.preventSelfApproval }
              : {}),
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "trigger", target: gateNodeId, sourceHandle: "next" }],
  };
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, ${"Test approval"}, ${opts.subjectKind}, true, ${JSON.stringify(graph)}::jsonb)`);
  return { flowId, gateNodeId };
}

/** Insert a minimal draft document for approval-lifecycle tests. */
export async function seedDraftDocument(
  orgId: string,
  opts: { kind: string; createdBy: string; total?: string; number?: string },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, currency,
       subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, ${opts.kind}, 'draft', ${opts.number ?? `T-${id.slice(0, 8)}`},
            '2026-07-15', 'CAD', ${opts.total ?? "100.00"}, '0.00', ${opts.total ?? "100.00"}, ${opts.createdBy})`);
  return id;
}

// ---------------------------------------------------------------------------
// Teardown. Schema-driven: the set of tables to clear is enumerated from
// information_schema at runtime, so a new org_id table can never silently
// leak scratch rows onto the shared dev database — it is either deleted by a
// generic pass or reported by the final zero-rows verification. The pass
// structure and the core delete order are the validated 2026-08-04 mass-purge
// runbook (memory: openbooks-org-teardown).
// ---------------------------------------------------------------------------

type TeardownTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SQL_IDENT = /^[a-z_][a-z0-9_]*$/;

function qualified(table: string) {
  if (!SQL_IDENT.test(table)) throw new Error(`unsafe table identifier: ${table}`);
  return sql.raw(`public."${table}"`);
}

/**
 * Kernel-guard bypasses for the teardown transaction: `openbooks.amend` lets
 * posted documents/journal entries be deleted, `openbooks.sandbox_wipe` (with
 * the org flagged env_kind='sandbox') satisfies the append-only evidence
 * guards, and `app.bypass_rls` makes the wipe authoritative even for direct
 * callers outside the test runner's ambient bypass.
 */
async function setTeardownGucs(tx: TeardownTx): Promise<void> {
  await tx.execute(sql`
    select set_config('openbooks.amend', 'on', true),
           set_config('openbooks.sandbox_wipe', 'on', true),
           set_config('app.bypass_rls', 'on', true)`);
}

/** Every base table in public that carries an org_id column. */
export async function listOrgIdTables(): Promise<string[]> {
  const result = (await db.execute<{ tableName: string }>(sql`
    select c.table_name as "tableName"
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'org_id'
       and t.table_type = 'BASE TABLE'
     order by c.table_name`));
  return result.rows.map((r) => r.tableName);
}

/**
 * Rows still present for the org across every org_id table (plus the orgs row
 * itself), keyed by table name. Empty object = fully deleted.
 */
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
          (t) => sql`select ${t}::text as "tableName", count(*)::int as n from ${qualified(t)} where org_id = ${orgId}`,
        ),
      ],
      sql` union all `,
    );
    const result = (await tx.execute<{ tableName: string; n: number }>(union));
    for (const row of result.rows) if (Number(row.n) > 0) counts[row.tableName] = Number(row.n);
  });
  return counts;
}

/**
 * The interlocked core the generic passes cannot clear, children first.
 * Tx A holds the document/journal/time/inventory web — the only genuine FK
 * cycle (documents.posted_entry_id ↔ journal_entries.source_document_id) is
 * resolved by deferring ONLY documents_posted_entry_id_fkey, never
 * `set constraints all deferred` (a large deferred check queue made COMMIT
 * hang for minutes on the shared DB).
 */
const CORE_A = [
  "inventory_provisional_costs",
  "cost_layers",
  "inventory_movements",
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
  "serials",
  "lots",
  "stock_locations",
  "locations",
  "projects",
  "project_types",
  "time_types",
  // equipment_units.charge_item_id references items.
  "equipment_units",
  "item_rate_versions",
  "item_rate_books",
  "items",
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

/**
 * Evidence tables whose delete guards have NO sandbox-wipe bypass (they raise
 * unconditionally). When rows exist the only teardown path is disabling the
 * specific guard trigger for the duration of one transaction — the ALTER takes
 * an exclusive lock, so concurrent writers wait and never see the gap.
 */
const GUARDED_EVIDENCE: { table: string; trigger: string }[] = [
  { table: "field_ticket_labor_lines", trigger: "field_ticket_labor_line_immutable" },
  { table: "field_ticket_labor_snapshots", trigger: "field_ticket_labor_snapshot_retention" },
  { table: "project_financial_profile_versions", trigger: "project_financial_profile_version_guard" },
];

/**
 * One generic pass in a single round trip: a server-side DO block attempts
 * `delete … where org_id` per table, each inside its own exception subblock
 * (a savepoint), and reports the failures. ~340 per-table transactions from
 * the client took ~20s against the remote dev DB; this takes one.
 */
async function bulkDeletePass(
  orgId: string,
  tables: string[],
): Promise<{ table: string; error: string }[]> {
  for (const t of tables) {
    if (!SQL_IDENT.test(t)) throw new Error(`unsafe table identifier: ${t}`);
  }
  return await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
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
    const r = (await tx.execute<{ table: string; error: string }>(sql`
      select table_name as "table", error from scratch_teardown_failures`));
    return r.rows;
  });
}

/**
 * Repeat delete passes until every table succeeded or a pass makes no
 * progress. Deferred constraint triggers surface at COMMIT of the whole bulk
 * pass, where the exception subblocks can't catch them — that aborts every
 * delete in the pass, so fall back to one transaction per table to isolate
 * (and report) the offender. Returns the tables that still fail, with the
 * last error per table for diagnostics.
 */
async function genericDeletePasses(
  orgId: string,
  tables: string[],
): Promise<{ remaining: string[]; errors: Map<string, unknown> }> {
  let remaining = tables;
  const errors = new Map<string, unknown>();
  for (let pass = 0; pass < 10 && remaining.length > 0; pass++) {
    let failed: string[];
    try {
      const failures = await bulkDeletePass(orgId, remaining);
      failed = failures.map((f) => f.table);
      for (const t of remaining) errors.delete(t);
      for (const f of failures) errors.set(f.table, new Error(f.error));
    } catch {
      failed = [];
      for (const t of remaining) {
        try {
          await db.transaction(async (tx) => {
            await setTeardownGucs(tx);
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

/**
 * Remove ALL scratch-org data and verify nothing is left. Refuses any org not
 * named 'Scratch %' — the shared dev database also holds real production
 * data, so the guard is absolute. Idempotent: a repeat call (or a call after
 * a partial failure) resumes and finishes the wipe.
 */
export async function dropScratchOrg(orgId: string): Promise<void> {
  // The wipe is inherently multi-transaction (per-step commits, trigger
  // disable/enable, one targeted deferred constraint) and MUST NOT participate
  // in a caller's pinned transaction: inside withBypass/withOrg the db proxy
  // folds every db.transaction() into the caller's single uncommitted
  // transaction, so the deletes never commit on their own, the verification
  // below reads that uncommitted state and passes, the first failure aborts
  // the shared transaction (25P02 for everything after), and the caller's
  // final rollback silently undoes every "successful" drop — the 2026-08-16
  // mass-purge phantom. Escaping to a context-only bypass scope gives every
  // internal transaction its own connection, commit, and rollback.
  return withBypassContext(() => dropScratchOrgEscaped(orgId));
}

async function dropScratchOrgEscaped(orgId: string): Promise<void> {
  // Hard scope guard. If the orgs row is gone the wipe already completed
  // (orgs is deleted last); if it exists under any other name, refuse.
  const orgRow = await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    const r = (await tx.execute<{ name: string }>(sql`select name from orgs where id = ${orgId}`));
    return r.rows[0];
  });
  if (!orgRow) {
    // "Already deleted" must be proven, not assumed: if the org row is merely
    // invisible (RLS misconfiguration) or a previous run died between deleting
    // orgs and finishing, silent success here is how leaks go unnoticed.
    const leftovers = await orgRowCounts(orgId);
    if (Object.keys(leftovers).length > 0) {
      throw new Error(
        `dropScratchOrg(${orgId}): orgs row is not visible but org-scoped rows remain ` +
          `(${JSON.stringify(leftovers)}) — refusing to report success`,
      );
    }
    return;
  }
  if (!orgRow.name.startsWith("Scratch ")) {
    throw new Error(
      `dropScratchOrg refused: org ${orgId} is named ${JSON.stringify(orgRow.name)}, not 'Scratch %'`,
    );
  }

  const orgTables = await listOrgIdTables();
  const present = new Set(orgTables);
  const coreA = CORE_A.filter((t) => present.has(t));
  const coreB = CORE_B.filter((t) => present.has(t));
  const core = new Set([...coreA, ...coreB]);

  // Prep: flag the org sandbox (sandbox-wipe guards check env_kind), park
  // users inactive BEFORE role_assignments go (role_assignments_active_user_guard
  // forbids leaving an ACTIVE user roleless), demote posted inventory
  // movements (inv_move_guard allows posted→pending but not delete-posted),
  // and clear the known non-org_id children reachable only through parents.
  await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId} and name like 'Scratch %'`);
    await tx.execute(sql`update users set is_active = false where org_id = ${orgId}`);
    await tx.execute(sql`update inventory_movements set status = 'pending' where org_id = ${orgId} and status = 'posted'`);
    // Payroll bank files are money-moving evidence with UNCONDITIONAL guards
    // (no sandbox-wipe bypass): pay_run_bank_file_immutable forbids their
    // delete outright, and payroll_bank_file_blob_immutable blocks deleting
    // any file_blob a pay_run_bank_files row still references. Disable both
    // for this one transaction and clear the bank-file rows BEFORE the blob
    // delete below; the ALTERs take an exclusive lock, so pay for them only
    // when such rows exist.
    const bankFiles = (await tx.execute(
      sql`select 1 as x from pay_run_bank_files where org_id = ${orgId} limit 1`,
    ));
    const hasBankFiles = bankFiles.rows.length > 0;
    if (hasBankFiles) {
      await tx.execute(sql.raw(`alter table public."pay_run_bank_files" disable trigger pay_run_bank_file_immutable`));
      await tx.execute(sql.raw(`alter table public."file_blobs" disable trigger payroll_bank_file_blob_immutable`));
      await tx.execute(sql`delete from pay_run_bank_files where org_id = ${orgId}`);
    }
    await tx.execute(sql`delete from file_blobs where version_id in
      (select v.id from file_versions v join files f on f.id = v.file_id where f.org_id = ${orgId})`);
    await tx.execute(sql`delete from file_versions where file_id in (select id from files where org_id = ${orgId})`);
    if (hasBankFiles) {
      await tx.execute(sql.raw(`alter table public."file_blobs" enable trigger payroll_bank_file_blob_immutable`));
      await tx.execute(sql.raw(`alter table public."pay_run_bank_files" enable trigger pay_run_bank_file_immutable`));
    }
    await tx.execute(sql`delete from tax_group_members where tax_group_id in (select id from tax_groups where org_id = ${orgId})`);
  });

  // Evidence tables with unconditional delete guards: disable the specific
  // guard trigger, delete, re-enable — all inside one transaction, and only
  // when rows actually exist (the ALTER needs table ownership and a brief
  // exclusive lock, so don't pay for it on every teardown).
  for (const { table, trigger } of GUARDED_EVIDENCE) {
    if (!present.has(table)) continue;
    if (!SQL_IDENT.test(trigger)) throw new Error(`unsafe trigger identifier: ${trigger}`);
    await db.transaction(async (tx) => {
      await setTeardownGucs(tx);
      const r = (await tx.execute(
        sql`select 1 as x from ${qualified(table)} where org_id = ${orgId} limit 1`,
      ));
      if (r.rows.length === 0) return;
      await tx.execute(sql.raw(`alter table public."${table}" disable trigger ${trigger}`));
      await tx.execute(sql`delete from ${qualified(table)} where org_id = ${orgId}`);
      await tx.execute(sql.raw(`alter table public."${table}" enable trigger ${trigger}`));
    });
  }

  // payment_schedules.last_payment_run_id ↔ payment_runs.source_schedule_id is
  // a second genuine FK cycle (both DEFERRABLE). Break it the same way the
  // time_entries nulling below breaks its cycle: clear the schedule-side link
  // so generic passes can delete payment_schedule_occurrences (child of both),
  // then the runs, then the schedules.
  await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    await tx.execute(sql`update payment_schedules
      set last_payment_run_id = null where org_id = ${orgId}`);
  });

  // Generic passes over every non-core org_id table. Deleting a child never
  // violates an FK, so repeated passes clear whole dependency chains; what
  // stays blocked is (a) the interlocked core and (b) parents of the core,
  // retried after tx A below.
  let { remaining } = await genericDeletePasses(
    orgId,
    orgTables.filter((t) => !core.has(t)),
  );

  // Tx A — the interlocked heavy core, children first. time_entries ↔
  // document_lines cross-reference each other (invoiced_by_line_id /
  // time_entry_id), so null the time side, then delete lines before entries.
  await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    await tx.execute(sql`update time_entries
      set invoiced_by_line_id = null, cost_journal_entry_id = null
      where org_id = ${orgId}`);
    for (const t of coreA) {
      if (t === "journal_entries") {
        // documents.posted_entry_id → journal_entries is the one genuine
        // cycle; documents.reversal_entry_id → journal_entries joins it
        // whenever a payment reversal linked the pair. Both are DEFERRABLE,
        // so defer exactly those two for the JE+document pass.
        await tx.execute(sql`set constraints documents_posted_entry_id_fkey, documents_reversal_entry_id_fkey deferred`);
      }
      await tx.execute(sql`delete from ${qualified(t)} where org_id = ${orgId}`);
    }
  });

  // Anything that was still blocked (e.g. parents of inventory_movements like
  // transfer_order_lines) unblocks once the core is gone.
  if (remaining.length > 0) {
    const retry = await genericDeletePasses(orgId, remaining);
    remaining = retry.remaining;
    if (remaining.length > 0) {
      const detail = remaining
        .map((t) => `${t}: ${retry.errors.get(t) instanceof Error ? (retry.errors.get(t) as Error).message : String(retry.errors.get(t))}`)
        .join("; ");
      throw new Error(`dropScratchOrg(${orgId}) could not clear tables — ${detail}`);
    }
  }

  // Tx B — master-data parents, then the org row itself (name-guarded again).
  await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    for (const t of coreB) {
      await tx.execute(sql`delete from ${qualified(t)} where org_id = ${orgId}`);
    }
    await tx.execute(sql`delete from orgs where id = ${orgId} and name like 'Scratch %'`);
  });

  // Verify: zero rows across every org_id table (and no orgs row). A leak
  // here means the schema grew a shape this teardown doesn't understand —
  // fail loudly instead of littering the shared database.
  const leftovers = await orgRowCounts(orgId);
  if (Object.keys(leftovers).length > 0) {
    throw new Error(`dropScratchOrg(${orgId}) left rows behind: ${JSON.stringify(leftovers)}`);
  }
}

/**
 * dropScratchOrg for finally blocks: a teardown failure must not replace the
 * test's own in-flight error, but silently swallowing it is how leaked orgs
 * went unnoticed for months — report it and let the test result stand.
 */
export async function dropScratchOrgReporting(orgId: string): Promise<void> {
  try {
    await dropScratchOrg(orgId);
  } catch (error) {
    console.error(`scratch-org teardown failed for ${orgId} (rows may be leaked on the shared dev DB):`, error);
  }
}
