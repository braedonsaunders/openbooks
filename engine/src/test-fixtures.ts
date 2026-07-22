import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * DB test fixtures — a disposable scratch org with the full accounting spine a
 * subledger integration test needs (book, subsidiary, open period, accounts,
 * inventory items + profiles, a BOM, and a revenue-recognition item/rule).
 *
 * Tests run with no request context, so engine/src/db.ts falls back to trusted
 * bypass-RLS mode; these helpers therefore write across the scratch org freely.
 * dropScratchOrg tears everything down under `openbooks.amend = on` so it can
 * remove the posted journal entries the kernel otherwise pins as immutable.
 */

export interface ScratchOrg {
  orgId: string;
  subsidiaryId: string;
  periodId: string;
  bookId: string;
  locationId: string;
  stockLocationId: string;
  stockLocationId2: string;
  accounts: Record<
    "invAsset" | "cogs" | "adjustment" | "clearing" | "freight" | "ar" | "ap" | "bank" | "revenue" | "deferred" | "recognized" | "fxGainLoss",
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

  await db.execute(sql`
    insert into orgs (id, name, base_currency, country, settings, env_kind)
    values (${orgId}, ${"Scratch " + orgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb, 'production')`);

  const fiscalCalendarId = randomUUID();
  await db.execute(sql`
    insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                  adjustment_period_enabled, is_default, is_active, config)
    values (${fiscalCalendarId}, ${orgId}, 'Default', 'monthly', 1, 1, 'UTC', false, true, true, '{}'::jsonb)`);

  const periodId = randomUUID();
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${periodId}, ${orgId}, 2026, 7, '2026-07', '2026-07-01', '2026-07-31', false, ${fiscalCalendarId})`);

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
  ];
  const accounts = {} as ScratchOrg["accounts"];
  for (const [key, number, name, type] of acctDefs) {
    const id = randomUUID();
    accounts[key] = id;
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  }

  // Org control accounts (for document posting).
  await db.execute(sql`
    update orgs set settings = ${JSON.stringify({ controlAccounts: { ar: accounts.ar, ap: accounts.ap, bank: accounts.bank, fxRealizedGainLoss: accounts.fxGainLoss } })}::jsonb
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

  return { orgId, subsidiaryId, periodId, bookId, locationId, stockLocationId, stockLocationId2, accounts, items, recognitionRuleId, customerId, vendorId, date };
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

/** Seed the users an approval-flow test needs. Passwords are placeholders. */
export async function seedFlowActors(orgId: string): Promise<FlowActors> {
  const mk = async (name: string, role: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, role, is_active)
      values (${id}, ${orgId}, ${`u-${id.slice(0, 8)}@scratch.test`}, ${name}, 'x', ${role}, true)`);
    return id;
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

/** Remove all scratch-org data, bypassing the kernel's posted-entry immutability. */
export async function dropScratchOrg(orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Bypass the posted-entry immutability guard AND the root-subsidiary delete
    // guard (the latter needs the org flagged sandbox + the wipe GUC).
    await tx.execute(sql`set local openbooks.amend = 'on'`);
    await tx.execute(sql`set local openbooks.sandbox_wipe = 'on'`);
    // Defer FK checks to commit so the circular documents ↔ journal_entries
    // (and paired-movement) references don't dictate a delete order.
    await tx.execute(sql`set constraints all deferred`);
    await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
    // inv_move_guard blocks deleting POSTED movements but allows posted→pending;
    // demote them first so the delete can proceed.
    await tx.execute(sql`update inventory_movements set status = 'pending' where org_id = ${orgId}`);
    const tables = [
      "flow_run_effects",
      "flow_gates",
      "flow_runs",
      "flows",
      "approval_delegations",
      "notifications",
      "role_assignments",
      "app_roles",
      "cost_layer_consumptions",
      "landed_cost_allocations",
      "cost_layers",
      "inventory_movements",
      "charge_rate_components",
      "recognition_schedule_lines",
      "recognition_schedules",
      "performance_obligations",
      "revenue_contracts",
      "applications",
      "document_links",
      "document_line_tax_components",
      "document_lines",
      "documents",
      "journal_lines",
      "journal_entries",
      "equipment_units",
      "labor_rate_adjustment_targets",
      "labor_rate_adjustments",
      "labor_rate_terms",
      "labor_rate_version_scopes",
      "labor_rate_version_policies",
      "item_rate_lines",
      "item_rate_profiles",
      "item_rate_book_assignments",
      "item_rate_versions",
      "item_rate_books",
      "item_inventory_profiles",
      "bom_components",
      "items",
      "recognition_rules",
      "projects",
      "parties",
      "stock_locations",
      "locations",
      "users",
      "accounting_periods",
      "fiscal_calendars",
      "accounting_books",
      "subsidiaries",
      "accounts",
      // Trigger-seeded on org insert; must go while the org row still exists —
      // segment_definition_guard's sandbox-wipe check looks the org up by id,
      // so a cascade from `delete from orgs` arrives too late and is rejected.
      "segment_definitions",
      "project_types",
    ];
    for (const t of tables) {
      await tx.execute(sql`delete from ${sql.raw(t)} where org_id = ${orgId}`);
    }
    await tx.execute(sql`delete from orgs where id = ${orgId}`);
  });
}
