import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";

export interface ScratchOrg {
  orgId: string;
  subsidiaryId: string;
  periodId: string;
  bookId: string;
  locationId: string;
  stockLocationId: string;
  stockLocationId2: string;
  accounts: Record<
    | "invAsset"
    | "cogs"
    | "adjustment"
    | "clearing"
    | "freight"
    | "ar"
    | "ap"
    | "bank"
    | "revenue"
    | "deferred"
    | "recognized"
    | "fxGainLoss"
    | "taxInput"
    | "taxOutput"
    | "withholding",
    string
  >;
  items: Record<"fifo" | "movingAvg" | "standard" | "component" | "assembly" | "service", string>;
  recognitionRuleId: string;
  customerId: string;
  vendorId: string;
  /** a date inside the open period. */
  date: string;
  /** Internal pool snapshot keys; callers should treat this as opaque. */
  readonly baselineIds?: Readonly<Record<string, readonly string[]>>;
  /** Database-backed template schema used for committed lease resets. */
  readonly snapshotSchema?: string;
}

/** Build a disposable tenant inside its own bypass scope. */
export async function bootstrapScratchOrg(): Promise<ScratchOrg> {
  return withBypassContext(bootstrapScratchOrgEscaped);
}

async function bootstrapScratchOrgEscaped(): Promise<ScratchOrg> {
  const orgId = randomUUID();
  const date = "2026-07-15";
  const baselineIds: Record<string, string[]> = {};
  const mark = (table: string, id: string) => {
    (baselineIds[table] ??= []).push(id);
    return id;
  };

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

  const fiscalCalendarId = mark("fiscal_calendars", randomUUID());
  await db.execute(sql`
    insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                  adjustment_period_enabled, is_default, is_active, config)
    values (${fiscalCalendarId}, ${orgId}, 'Default', 'monthly', 1, 1, 'UTC', false, true, true, '{}'::jsonb)`);

  // Keep the fixture's accounting spine to one open period. Suites that need
  // future or historical months seed those periods explicitly so their
  // scenario-specific calendars cannot collide with shared fixture defaults.
  const periodId = mark("accounting_periods", randomUUID());
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${periodId}, ${orgId}, 2026, 7, '2026-07', '2026-07-01', '2026-07-31', false, ${fiscalCalendarId})`);

  const bookId = mark("accounting_books", randomUUID());
  await db.execute(sql`
    insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${bookId}, ${orgId}, 'PRI', 'Primary', true, true, true)`);

  const subsidiaryId = mark("subsidiaries", randomUUID());
  await db.execute(sql`
    insert into subsidiaries (id, org_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subsidiaryId}, ${orgId}, 'Main Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);

  const locationId = mark("locations", randomUUID());
  await db.execute(sql`
    insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children)
    values (${locationId}, ${orgId}, 'HQ', true, '{}'::jsonb, true)`);
  const locationId2 = mark("locations", randomUUID());
  await db.execute(sql`
    insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children)
    values (${locationId2}, ${orgId}, 'DC', true, '{}'::jsonb, true)`);

  const stockLocationId = mark("stock_locations", randomUUID());
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values (${stockLocationId}, ${orgId}, ${locationId}, 'MAIN', 'warehouse', true)`);
  const stockLocationId2 = mark("stock_locations", randomUUID());
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
    const id = mark("accounts", randomUUID());
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
  async function inventoryItem(
    name: string,
    method: "fifo" | "moving_average" | "standard",
    standardCost?: string,
  ): Promise<string> {
    const id = mark("items", randomUUID());
    await db.execute(sql`
      insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
      values (${id}, ${orgId}, 'inventory', ${name}, false, true, '{}'::jsonb, 'billing', 'normal', ${accounts.revenue})`);
    const profileId = mark("item_inventory_profiles", randomUUID());
    await db.execute(sql`
      insert into item_inventory_profiles
        (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
         variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
      values (${profileId}, ${orgId}, ${id}, ${method}, 'none', ${accounts.invAsset}, ${accounts.cogs}, ${accounts.adjustment},
              ${accounts.adjustment}, ${accounts.clearing}, ${standardCost ?? null}, 'ea', '{}'::jsonb)`);
    return id;
  }
  const items = {
    fifo: await inventoryItem("FIFO Widget", "fifo"),
    movingAvg: await inventoryItem("Avg Widget", "moving_average"),
    standard: await inventoryItem("Std Widget", "standard", "2.00"),
    component: await inventoryItem("Component", "fifo"),
    assembly: await inventoryItem("Assembly", "fifo"),
    service: mark("items", randomUUID()),
  } as ScratchOrg["items"];

  // BOM: assembly needs 2 components.
  const bomId = mark("bom_components", randomUUID());
  await db.execute(sql`
    insert into bom_components (id, org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
    values (${bomId}, ${orgId}, ${items.assembly}, ${items.component}, '2', 0)`);

  // Revenue recognition rule + service item.
  const recognitionRuleId = mark("recognition_rules", randomUUID());
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

  const customerId = mark("parties", randomUUID());
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${customerId}, ${orgId}, 'customer', 'Acme Customer', true, '{}'::jsonb)`);

  const vendorId = mark("parties", randomUUID());
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${vendorId}, ${orgId}, 'vendor', 'Acme Vendor', true, '{}'::jsonb)`);

  mark("orgs", orgId);
  return {
    orgId,
    subsidiaryId,
    periodId,
    bookId,
    locationId,
    stockLocationId,
    stockLocationId2,
    accounts,
    items,
    recognitionRuleId,
    customerId,
    vendorId,
    date,
    baselineIds,
  };
}
