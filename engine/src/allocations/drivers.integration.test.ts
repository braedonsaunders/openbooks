import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createDriver,
  createDriverValue,
  listDriverValues,
  updateDriverValue,
} from "./driver-admin.ts";
import {
  DriverNotAvailableError,
  createDriverResolver,
  previewDriverVector,
  type DriverResolveOptions,
} from "./drivers.ts";
import type { AllocationDriver } from "./types.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../test-fixtures.ts";

function makeDriver(orgId: string, overrides: Partial<AllocationDriver> = {}): AllocationDriver {
  return {
    id: randomUUID(),
    orgId,
    key: `drv-${randomUUID().slice(0, 8)}`,
    name: "Test driver",
    unit: null,
    dimension: "department",
    sourceKind: "manual",
    config: {},
    isActive: true,
    ...overrides,
  };
}

async function makeDept(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into departments (id, org_id, name) values (${id}, ${orgId}, ${name})`);
  return id;
}

interface SeedLine {
  accountId: string;
  amount: string;
  departmentId?: string | null;
  locationId?: string | null;
  subsidiaryId?: string;
  quantity?: string | null;
  unit?: string | null;
  extraDims?: Record<string, string>;
}

async function postBalanced(
  org: ScratchOrg,
  lines: SeedLine[],
  label: string,
  date?: string,
): Promise<string> {
  const entryId = randomUUID();
  // One transaction: the deferred per-entry balance trigger checks at
  // commit, so entry + lines + post must land atomically.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`ALLOC-A2-${label}-${entryId.slice(0, 8)}`}, ${date ?? org.date}, ${org.periodId},
         ${`alloc a2 ${label}`}, 'draft', 'manual')
    `);
    let lineNumber = 0;
    for (const line of lines) {
      lineNumber += 1;
      await tx.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, department_id, location_id,
           quantity, unit, extra_dims)
        values
          (${randomUUID()}, ${org.orgId}, ${entryId}, ${lineNumber},
           ${line.accountId}, ${line.subsidiaryId ?? org.subsidiaryId},
           ${line.amount}, 'CAD', ${line.amount}, 1,
           ${line.departmentId ?? null}, ${line.locationId ?? null},
           ${line.quantity ?? null}, ${line.unit ?? null},
           ${JSON.stringify(line.extraDims ?? {})}::jsonb)
      `);
    }
    await tx.execute(sql`
      update journal_entries set status = 'posted'
      where id = ${entryId} and org_id = ${org.orgId}
    `);
  });
  return entryId;
}

function vectorObject(vector: Map<string, string>): Record<string, string> {
  return Object.fromEntries(vector.entries());
}

// ---------------------------------------------------------------------------
// statistical_journal
// ---------------------------------------------------------------------------

test("drivers: statistical_journal sums quantity by department for the period", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    const deptB = await makeDept(org.orgId, "Dept B");
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "100", departmentId: deptA, quantity: "10", unit: "hours" },
      { accountId: org.accounts.clearing, amount: "-100", departmentId: deptA },
      { accountId: org.accounts.adjustment, amount: "200", departmentId: deptB, quantity: "30", unit: "hours" },
      { accountId: org.accounts.clearing, amount: "-200", departmentId: deptB },
    ], "stat");
    const resolver = createDriverResolver();
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "statistical_journal", config: { unit: "hours" } }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(vector), { [deptA]: "10.0000", [deptB]: "30.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: statistical_journal honours unit + accountIds filters and the as-of month", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "100", departmentId: deptA, quantity: "10", unit: "hours" },
      { accountId: org.accounts.freight, amount: "50", departmentId: deptA, quantity: "7", unit: "tonnes" },
      { accountId: org.accounts.clearing, amount: "-150", departmentId: deptA },
    ], "stat-unit");
    const resolver = createDriverResolver();
    const byUnit = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, {
        sourceKind: "statistical_journal",
        config: { unit: "hours", accountIds: [org.accounts.adjustment, org.accounts.freight] },
      }),
      asOf: { date: org.date },
    });
    assert.deepEqual(vectorObject(byUnit), { [deptA]: "10.0000" });
    const otherMonth = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "statistical_journal", config: { unit: "hours" } }),
      asOf: { date: "2026-06-10" },
    });
    assert.deepEqual(vectorObject(otherMonth), {});
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: statistical_journal groups by extra segment values", async () => {
  const org = await createScratchOrg();
  try {
    const segmentId = randomUUID();
    await db.execute(sql`
      insert into segment_definitions (id, org_id, key, name, plural_name, source_kind)
      values (${segmentId}, ${org.orgId}, 'region', 'Region', 'Regions', 'custom')
    `);
    const regionA = randomUUID();
    const regionB = randomUUID();
    await db.execute(sql`
      insert into segment_values (id, org_id, segment_id, name)
      values (${regionA}, ${org.orgId}, ${segmentId}, 'North'),
             (${regionB}, ${org.orgId}, ${segmentId}, 'South')
    `);
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "100", quantity: "5", unit: "sqft", extraDims: { region: regionA } },
      { accountId: org.accounts.clearing, amount: "-100" },
      { accountId: org.accounts.adjustment, amount: "100", quantity: "15", unit: "sqft", extraDims: { region: regionB } },
      { accountId: org.accounts.clearing, amount: "-100" },
    ], "stat-extra");
    const resolver = createDriverResolver();
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, {
        dimension: "extra:region",
        sourceKind: "statistical_journal",
        config: { unit: "sqft" },
      }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(vector), { [regionA]: "5.0000", [regionB]: "15.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// manual
// ---------------------------------------------------------------------------

test("drivers: manual reads values effective on the as-of date", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Driver owner", "admin");
    const deptA = await makeDept(org.orgId, "Dept A");
    const deptB = await makeDept(org.orgId, "Dept B");
    const driver = await createDriver(org.orgId, actor, {
      key: `manual-${randomUUID().slice(0, 8)}`,
      name: "Manual weights",
      dimension: "department",
      sourceKind: "manual",
      config: {},
    });
    await createDriverValue(org.orgId, actor, driver.id, {
      dimensionValueId: deptA, effectiveFrom: "2026-07-01", effectiveTo: "2026-07-31", value: "60",
    });
    await createDriverValue(org.orgId, actor, driver.id, {
      dimensionValueId: deptB, effectiveFrom: "2026-07-01", effectiveTo: null, value: "40",
    });
    const resolver = createDriverResolver();
    const inWindow = await resolver.resolve({
      orgId: org.orgId,
      driver,
      asOf: { date: "2026-07-15" },
    });
    assert.deepEqual(vectorObject(inWindow), { [deptA]: "60.0000", [deptB]: "40.0000" });
    // A period as-of resolves to the period end date.
    const period = await resolver.resolve({
      orgId: org.orgId,
      driver,
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(period), { [deptA]: "60.0000", [deptB]: "40.0000" });
    const before = await resolver.resolve({
      orgId: org.orgId,
      driver,
      asOf: { date: "2026-06-30" },
    });
    assert.deepEqual(vectorObject(before), {});
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: manual values reject overlapping windows per dimension value", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Driver owner", "admin");
    const deptA = await makeDept(org.orgId, "Dept A");
    const driver = await createDriver(org.orgId, actor, {
      key: `manual-${randomUUID().slice(0, 8)}`,
      name: "Manual overlap",
      dimension: "department",
      sourceKind: "manual",
      config: {},
    });
    const first = await createDriverValue(org.orgId, actor, driver.id, {
      dimensionValueId: deptA, effectiveFrom: "2026-07-01", effectiveTo: "2026-07-31", value: "60",
    });
    await assert.rejects(
      createDriverValue(org.orgId, actor, driver.id, {
        dimensionValueId: deptA, effectiveFrom: "2026-07-15", effectiveTo: "2026-08-15", value: "10",
      }),
      /overlap/,
    );
    // Updating the existing row keeps one window and re-resolves the vector.
    const updated = await updateDriverValue(org.orgId, actor, first.id, { value: "70" });
    assert.equal(updated.value, "70.0000");
    const listed = await listDriverValues(org.orgId, driver.id);
    assert.equal(listed.length, 1);
    const resolver = createDriverResolver();
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver,
      asOf: { date: "2026-07-15" },
    });
    assert.deepEqual(vectorObject(vector), { [deptA]: "70.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// gl_activity / gl_balance
// ---------------------------------------------------------------------------

test("drivers: gl_activity sums signed activity over an account scope", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    const deptB = await makeDept(org.orgId, "Dept B");
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "100", departmentId: deptA },
      { accountId: org.accounts.clearing, amount: "-100", departmentId: deptA },
      { accountId: org.accounts.adjustment, amount: "-25", departmentId: deptB },
      { accountId: org.accounts.clearing, amount: "25", departmentId: deptB },
    ], "gl-act");
    const resolver = createDriverResolver();
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, {
        sourceKind: "gl_activity",
        config: { accountScope: { kind: "accounts", accountIds: [org.accounts.adjustment] } },
      }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(vector), { [deptA]: "100.0000", [deptB]: "-25.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: gl_activity honours account-group scope and rule-lineage exclusion", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    const groupId = randomUUID();
    await db.execute(sql`
      insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'cost_pool', 'pool_a', 'Pool A',
              ${JSON.stringify({ numberPrefixes: ["9"] })}::jsonb, false, true)
    `);
    // Pin the adjustment account into the group (rule would also match by number).
    await db.execute(sql`
      insert into account_group_members (id, org_id, group_id, account_id, dimension)
      values (${randomUUID()}, ${org.orgId}, ${groupId}, ${org.accounts.adjustment}, 'cost_pool')
    `);
    const producedLineId = randomUUID();
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`ALLOC-A2-excl-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         'alloc a2 exclusion', 'draft', 'manual')
    `);
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, department_id)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1,
         ${org.accounts.adjustment}, ${org.subsidiaryId}, 100, 'CAD', 100, 1, ${deptA}),
        (${producedLineId}, ${org.orgId}, ${entryId}, 2,
         ${org.accounts.adjustment}, ${org.subsidiaryId}, 50, 'CAD', 50, 1, ${deptA}),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 3,
         ${org.accounts.clearing}, ${org.subsidiaryId}, -150, 'CAD', -150, 1, ${deptA})
    `);
    await db.execute(sql`
      update journal_entries set status = 'posted'
      where id = ${entryId} and org_id = ${org.orgId}
    `);
    // A prior run of rule X produced the 50 line; its lineage stamps that.
    const ruleId = randomUUID();
    const versionId = randomUUID();
    const runId = randomUUID();
    await db.execute(sql`
      insert into allocation_rules (id, org_id, key, name, mode)
      values (${ruleId}, ${org.orgId}, ${`rule-x-${ruleId.slice(0, 8)}`}, 'Rule X', 'period')
    `);
    await db.execute(sql`
      insert into allocation_rule_versions (id, org_id, rule_id, version_no, status, effective_from, definition_hash)
      values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'published', '2026-01-01', 'hash-x')
    `);
    await db.execute(sql`
      insert into allocation_runs (id, org_id, rule_id, version_id, definition_hash, period_id, book_id, status)
      values (${runId}, ${org.orgId}, ${ruleId}, ${versionId}, 'hash-x', ${org.periodId}, ${org.bookId}, 'posted')
    `);
    await db.execute(sql`
      insert into allocation_lineage
        (id, org_id, mode, rule_id, version_id, definition_hash, run_id, journal_line_id, amount)
      values
        (${randomUUID()}, ${org.orgId}, 'period', ${ruleId}, ${versionId}, 'hash-x', ${runId}, ${producedLineId}, 50)
    `);
    const resolver = createDriverResolver();
    const scope = { accountScope: { kind: "account_group", dimension: "cost_pool", groupKey: "pool_a" } } as const;
    const excludedRequest: DriverResolveOptions = {
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "gl_activity", config: scope }),
      asOf: { periodId: org.periodId },
      excludeRuleIds: [ruleId],
    };
    const excluded = await resolver.resolve(excludedRequest);
    assert.deepEqual(vectorObject(excluded), { [deptA]: "100.0000" });
    const included = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "gl_activity", config: scope }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(included), { [deptA]: "150.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: gl_balance accumulates through the period end", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    const calendar = (await db.execute<{ fiscal_calendar_id: string }>(
      sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`,
    )).rows[0]?.fiscal_calendar_id;
    assert.ok(calendar);
    const junePeriodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${junePeriodId}, ${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${calendar})
    `);
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "1000", departmentId: deptA },
      { accountId: org.accounts.clearing, amount: "-1000", departmentId: deptA },
    ], "gl-june", "2026-06-10");
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "100", departmentId: deptA },
      { accountId: org.accounts.clearing, amount: "-100", departmentId: deptA },
    ], "gl-july");
    const resolver = createDriverResolver();
    const scope = { accountScope: { kind: "accounts", accountIds: [org.accounts.adjustment] } };
    const balance = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "gl_balance", config: scope }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(balance), { [deptA]: "1100.0000" });
    const activity = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "gl_activity", config: scope }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(activity), { [deptA]: "100.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: gl_activity aggregates by subsidiary through the month rollup", async () => {
  const org = await createScratchOrg();
  try {
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "300" },
      { accountId: org.accounts.clearing, amount: "-300" },
    ], "gl-sub");
    const resolver = createDriverResolver();
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, {
        dimension: "subsidiary",
        sourceKind: "gl_activity",
        config: { accountScope: { kind: "accounts", accountIds: [org.accounts.adjustment] } },
      }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(vector), { [org.subsidiaryId]: "300.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// driverService CRUD
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// native_measure
// ---------------------------------------------------------------------------

async function makeEmployee(
  orgId: string,
  name: string,
  departmentId: string | null,
  hiredOn: string | null,
  terminatedOn: string | null,
): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name)
    values (${partyId}, ${orgId}, 'person', ${name})
  `);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, department_id, hired_on, terminated_on, is_active)
    values (${randomUUID()}, ${orgId}, ${partyId}, ${departmentId}, ${hiredOn}, ${terminatedOn}, true)
  `);
  return partyId;
}

test("drivers: native headcount counts roles active in the period", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    const deptB = await makeDept(org.orgId, "Dept B");
    await makeEmployee(org.orgId, "Active A1", deptA, "2026-01-05", null);
    await makeEmployee(org.orgId, "Active A2", deptA, "2026-07-10", null);
    await makeEmployee(org.orgId, "Gone", deptA, "2026-01-05", "2026-05-31");
    await makeEmployee(org.orgId, "Active B", deptB, null, null);
    await makeEmployee(org.orgId, "No dept", null, "2026-01-05", null);
    const resolver = createDriverResolver();
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, {
        sourceKind: "native_measure",
        config: { measure: "headcount" },
      }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(vector), { [deptA]: "2.0000", [deptB]: "1.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: native labor/billed hours read approved time only", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    const emp = await makeEmployee(org.orgId, "Worker", deptA, "2026-01-05", null);
    await db.execute(sql`
      insert into time_entries (id, org_id, employee_party_id, worked_on, hours, department_id, is_billable, status)
      values (${randomUUID()}, ${org.orgId}, ${emp}, '2026-07-08', 6, ${deptA}, true, 'approved'),
             (${randomUUID()}, ${org.orgId}, ${emp}, '2026-07-09', 2, ${deptA}, false, 'approved'),
             (${randomUUID()}, ${org.orgId}, ${emp}, '2026-07-10', 8, ${deptA}, true, 'draft')
    `);
    const resolver = createDriverResolver();
    const labor = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "native_measure", config: { measure: "labor_hours" } }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(labor), { [deptA]: "8.0000" });
    const billed = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "native_measure", config: { measure: "billed_hours" } }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(billed), { [deptA]: "6.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: native labor_cost, revenue, and direct_cost read the GL vocabulary", async () => {
  const org = await createScratchOrg();
  try {
    const deptA = await makeDept(org.orgId, "Dept A");
    const wagesId = randomUUID();
    const salesId = randomUUID();
    const cogsId = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, name, type)
      values (${wagesId}, ${org.orgId}, 'Wages Test', 'expense'),
             (${salesId}, ${org.orgId}, 'Sales Test', 'income'),
             (${cogsId}, ${org.orgId}, 'Direct Test', 'cogs')
    `);
    await postBalanced(org, [
      { accountId: wagesId, amount: "500", departmentId: deptA },
      { accountId: org.accounts.clearing, amount: "-500", departmentId: deptA },
      { accountId: org.accounts.clearing, amount: "2000", departmentId: deptA },
      { accountId: salesId, amount: "-2000", departmentId: deptA },
      { accountId: cogsId, amount: "700", departmentId: deptA },
      { accountId: org.accounts.clearing, amount: "-700", departmentId: deptA },
    ], "gl-vocab");
    const resolver = createDriverResolver();
    const labor = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "native_measure", config: { measure: "labor_cost" } }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(labor), { [deptA]: "500.0000" });
    const revenue = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "native_measure", config: { measure: "revenue" } }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(revenue), { [deptA]: "2000.0000" });
    const direct = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "native_measure", config: { measure: "direct_cost" } }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(direct), { [deptA]: "700.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: native rentable_area sums live units by property location", async () => {
  const org = await createScratchOrg();
  try {
    const locA = randomUUID();
    const locB = randomUUID();
    await db.execute(sql`
      insert into locations (id, org_id, name)
      values (${locA}, ${org.orgId}, 'Tower'), (${locB}, ${org.orgId}, 'Yard')
    `);
    const propA = randomUUID();
    const propB = randomUUID();
    const propDead = randomUUID();
    await db.execute(sql`
      insert into managed_properties
        (id, org_id, subsidiary_id, location_id, code, name, property_type, currency, status)
      values (${propA}, ${org.orgId}, ${org.subsidiaryId}, ${locA}, 'P-A', 'Tower block', 'commercial', 'CAD', 'active'),
             (${propB}, ${org.orgId}, ${org.subsidiaryId}, ${locB}, 'P-B', 'Yard block', 'commercial', 'CAD', 'active'),
             (${propDead}, ${org.orgId}, ${org.subsidiaryId}, ${locA}, 'P-X', 'Sold block', 'commercial', 'CAD', 'sold')
    `);
    await db.execute(sql`
      insert into property_units (id, org_id, property_id, code, rentable_area)
      values (${randomUUID()}, ${org.orgId}, ${propA}, 'A-1', 100),
             (${randomUUID()}, ${org.orgId}, ${propA}, 'A-2', 50),
             (${randomUUID()}, ${org.orgId}, ${propB}, 'B-1', 400),
             (${randomUUID()}, ${org.orgId}, ${propDead}, 'X-1', 999)
    `);
    const resolver = createDriverResolver();
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, {
        dimension: "location",
        sourceKind: "native_measure",
        config: { measure: "rentable_area" },
      }),
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(vectorObject(vector), { [locA]: "150.0000", [locB]: "400.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: native measures throw NotAvailable outside their vocabulary", async () => {
  const org = await createScratchOrg();
  try {
    const resolver = createDriverResolver();
    await assert.rejects(
      resolver.resolve({
        orgId: org.orgId,
        driver: makeDriver(org.orgId, {
          dimension: "department",
          sourceKind: "native_measure",
          config: { measure: "rentable_area" },
        }),
        asOf: { periodId: org.periodId },
      }),
      (error: unknown) => error instanceof DriverNotAvailableError,
    );
    await assert.rejects(
      resolver.resolve({
        orgId: org.orgId,
        driver: makeDriver(org.orgId, {
          dimension: "location",
          sourceKind: "native_measure",
          config: { measure: "headcount" },
        }),
        asOf: { periodId: org.periodId },
      }),
      (error: unknown) => error instanceof DriverNotAvailableError,
    );
    // Unknown measures are misconfiguration, rejected at registration.
    const actor = await createScratchUser(org.orgId, "Driver owner", "admin");
    await assert.rejects(
      createDriver(org.orgId, actor, {
        key: `bad-${randomUUID().slice(0, 8)}`,
        name: "Bad measure",
        dimension: "department",
        sourceKind: "native_measure",
        config: { measure: "vibes" },
      }),
      /must be one of/,
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// report_definition + preview
// ---------------------------------------------------------------------------

test("drivers: report_definition injects the period and runs under the actor", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Driver owner", "admin");
    const deptA = await makeDept(org.orgId, "Dept A");
    const seen: Array<Record<string, unknown>> = [];
    const resolver = createDriverResolver({
      reportRunner: {
        async runReport(input) {
          seen.push({ ...input });
          return [{ dimension: deptA, value: "12.5" }];
        },
      },
    });
    const vector = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, {
        sourceKind: "report_definition",
        config: {
          reportDefinitionId: randomUUID(),
          dimensionColumn: "department",
          valueColumn: "hours",
          params: { mode: "x" },
        },
      }),
      asOf: { periodId: org.periodId },
      actorId: actor,
    });
    assert.deepEqual(vectorObject(vector), { [deptA]: "12.5000" });
    assert.equal(seen.length, 1);
    const call = seen[0] as { from: string; to: string; actorId: string; params: Record<string, unknown> };
    assert.deepEqual({ from: call.from, to: call.to }, { from: "2026-07-01", to: "2026-07-31" });
    assert.equal(call.actorId, actor);
    assert.deepEqual(call.params, { mode: "x" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: report_definition refuses anonymous runs and missing runners", async () => {
  const org = await createScratchOrg();
  try {
    const withRunner = createDriverResolver({
      reportRunner: { async runReport() { return []; } },
    });
    await assert.rejects(
      withRunner.resolve({
        orgId: org.orgId,
        driver: makeDriver(org.orgId, {
          sourceKind: "report_definition",
          config: { reportDefinitionId: randomUUID(), dimensionColumn: "d", valueColumn: "v" },
        }),
        asOf: { periodId: org.periodId },
      }),
      /actorId/,
    );
    await assert.rejects(
      createDriverResolver().resolve({
        orgId: org.orgId,
        driver: makeDriver(org.orgId, {
          sourceKind: "report_definition",
          config: { reportDefinitionId: randomUUID(), dimensionColumn: "d", valueColumn: "v" },
        }),
        asOf: { periodId: org.periodId },
        actorId: randomUUID(),
      }),
      (error: unknown) => error instanceof DriverNotAvailableError,
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: preview returns sorted entries plus the total", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Driver owner", "admin");
    const deptA = await makeDept(org.orgId, "Dept A");
    const deptB = await makeDept(org.orgId, "Dept B");
    const driver = await createDriver(org.orgId, actor, {
      key: `preview-${randomUUID().slice(0, 8)}`,
      name: "Preview driver",
      dimension: "department",
      sourceKind: "manual",
      config: {},
    });
    await createDriverValue(org.orgId, actor, driver.id, {
      dimensionValueId: deptB, effectiveFrom: "2026-07-01", effectiveTo: null, value: "25",
    });
    await createDriverValue(org.orgId, actor, driver.id, {
      dimensionValueId: deptA, effectiveFrom: "2026-07-01", effectiveTo: null, value: "75",
    });
    const preview = await previewDriverVector({ orgId: org.orgId, driverId: driver.id, asOf: { periodId: org.periodId } });
    assert.deepEqual(preview.from, "2026-07-01");
    assert.deepEqual(preview.to, "2026-07-31");
    assert.deepEqual(preview.vector, [
      { key: deptA < deptB ? deptA : deptB, value: deptA < deptB ? "75.0000" : "25.0000" },
      { key: deptA < deptB ? deptB : deptA, value: deptA < deptB ? "25.0000" : "75.0000" },
    ]);
    assert.equal(preview.total, "100.0000");
    const scoped = await previewDriverVector({
      orgId: org.orgId,
      driverId: driver.id,
      asOf: { periodId: org.periodId },
      include: [deptA],
    });
    assert.deepEqual(scoped.vector, [{ key: deptA, value: "75.0000" }]);
    assert.equal(scoped.total, "75.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: statistical_journal respects the subsidiary scope", async () => {
  const org = await createScratchOrg();
  try {
    const sub2 = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${sub2}, ${org.orgId}, ${org.subsidiaryId}, 'Branch', 'CAD', 'CA')
    `);
    const deptA = await makeDept(org.orgId, "Dept A");
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "100", departmentId: deptA, quantity: "10", unit: "hours" },
      { accountId: org.accounts.clearing, amount: "-100", departmentId: deptA },
    ], "stat-home");
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "100", departmentId: deptA, quantity: "99", unit: "hours", subsidiaryId: sub2 },
      { accountId: org.accounts.clearing, amount: "-100", departmentId: deptA, subsidiaryId: sub2 },
    ], "stat-branch");
    const resolver = createDriverResolver();
    const scoped = await resolver.resolve({
      orgId: org.orgId,
      driver: makeDriver(org.orgId, { sourceKind: "statistical_journal", config: { unit: "hours" } }),
      asOf: { periodId: org.periodId },
      subsidiaryId: org.subsidiaryId,
    });
    assert.deepEqual(vectorObject(scoped), { [deptA]: "10.0000" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drivers: preview resolves an admin-created gl driver end to end", async () => {
  // Registry writes belong to driver-admin.ts (A8); evaluation reads the
  // stored canonical config back through the resolvers.
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Driver owner", "admin");
    const deptA = await makeDept(org.orgId, "Dept A");
    await postBalanced(org, [
      { accountId: org.accounts.adjustment, amount: "400", departmentId: deptA },
      { accountId: org.accounts.clearing, amount: "-400", departmentId: deptA },
    ], "gl-e2e");
    const created = await createDriver(org.orgId, actor, {
      key: `e2e-${randomUUID().slice(0, 8)}`,
      name: "E2E driver",
      dimension: "department",
      sourceKind: "gl_activity",
      config: { accountScope: { kind: "accounts", accountIds: [org.accounts.adjustment] } },
    });
    const preview = await previewDriverVector({
      orgId: org.orgId,
      driverId: created.id,
      asOf: { periodId: org.periodId },
    });
    assert.deepEqual(preview.vector, [{ key: deptA, value: "400.0000" }]);
    assert.equal(preview.total, "400.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
