import { sql } from "drizzle-orm";
import { addMoney, cmpMoney, negMoney, parseMoney, subMoney, type Money } from "../money/brands.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { db, type SqlExecutor, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { fundPostingRefusal, NonprofitError, type NonprofitStatus } from "./errors.ts";
import type { BalancingContext, BalancingLeg, BalancingLegProvider, BalancingLineView } from "../journal/balancing-hooks.ts";

const FEATURE_KEY = "encumbrances";
const FEATURE_REMEDY = "Enable encumbrances in Company Settings → Features.";
const EXPENSE_TYPES = new Set(["cogs", "expense", "expense_other", "expense_deferred"]);

export type EncumbranceStatus = "open" | "closed" | "void";
export type EncumbranceSourceKind = "purchase_order" | "manual";
export type BudgetaryControlMode = "off" | "advisory" | "hard";

export interface EncumbranceCellInput {
  accountId: string;
  subsidiaryId: string;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  extraDims?: Record<string, unknown> | null;
}

export interface CreateEncumbranceInput extends EncumbranceCellInput {
  orgId: string;
  sourceKind: EncumbranceSourceKind;
  sourceId?: string | null;
  amount: string;
  custom?: Record<string, unknown>;
  actorId?: string | null;
}

export interface EncumbranceBalance {
  encumbranceId: string;
  amount: Money;
  appliedActuals: Money;
  openBalance: Money;
}

export interface BudgetCellFigures {
  scenarioId: string;
  scenarioName: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  fundId: string;
  fundCode: string;
  fundName: string;
  subsidiaryId: string;
  subsidiaryName: string;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  locationId: string | null;
  locationName: string | null;
  classId: string | null;
  className: string | null;
  extraDims: Record<string, unknown>;
  appropriation: Money;
  actuals: Money;
  openEncumbrances: Money;
  available: Money;
}

export interface BudgetaryControlWarning extends BudgetCellFigures {
  entryId: string;
  amountOver: Money;
}

type AccountTypeLine = BalancingLineView & Record<string, unknown> & { type: string };

interface Cell {
  accountId: string;
  subsidiaryId: string;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  fundId: string;
  extraDims: Record<string, unknown>;
}

type Scenario = Record<string, unknown> & {
  id: string;
  name: string;
  fiscalYear: number;
};

interface ControlGroup {
  cell: Cell;
  mode: BudgetaryControlMode;
  amount: Money;
}

function refuse(message: string, code: string, remedy: string, status: NonprofitStatus = 422, field?: string): NonprofitError {
  return new NonprofitError({ message, code, remedy, status, ...(field ? { field } : {}) });
}

function featureOff(): NonprofitError {
  return refuse("Encumbrances are disabled; enable encumbrances in Company Settings → Features.", "feature_off", FEATURE_REMEDY);
}

async function requireEnabledForWrite(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, FEATURE_KEY))) throw featureOff();
}

async function requireEnabledForRead(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, FEATURE_KEY, runner))) throw featureOff();
}

function validExtraDims(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw refuse("Extra dimensions must be an object.", "encumbrance_dimensions_invalid", "Choose valid segment values for the commitment.", 422, "extraDims");
  }
  return value as Record<string, unknown>;
}

function positiveAmount(raw: unknown): Money {
  let amount: Money;
  try {
    amount = parseMoney(raw);
  } catch {
    throw refuse("The commitment amount must be an exact decimal.", "encumbrance_amount_invalid", "Enter an amount with no more than four decimal places.", 422, "amount");
  }
  if (cmpMoney(amount, "0.0000") <= 0) {
    throw refuse("The commitment amount must be greater than zero.", "encumbrance_amount_invalid", "Enter an amount greater than zero.", 422, "amount");
  }
  return amount;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function uuidArray(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}

function cellKey(cell: Cell): string {
  return JSON.stringify(canonical([
    cell.accountId, cell.subsidiaryId, cell.departmentId, cell.projectId,
    cell.locationId, cell.classId, cell.fundId, cell.extraDims,
  ]));
}

function lockKey(orgId: string, bookId: string | null, cell: Cell): string {
  return `openbooks:budget-cell:${orgId}:${bookId ?? "primary"}:${cellKey(cell)}`;
}

async function lockCell(runner: SqlExecutor, orgId: string, bookId: string | null, cell: Cell): Promise<void> {
  await runner.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${lockKey(orgId, bookId, cell)}, 0))
  `);
}

async function primaryBook(runner: SqlExecutor, orgId: string, requested: string | null): Promise<string | null> {
  const row = (await runner.execute<{ id: string; isPrimary: boolean }>(sql`
    select id, is_primary as "isPrimary" from accounting_books
     where org_id = ${orgId} and is_active and posts_gl
       and (id = ${requested}::uuid
            or (${requested}::uuid is null and is_primary))
     order by is_primary desc
     limit 1
  `)).rows[0];
  return row?.isPrimary ? row.id : null;
}

async function fiscalYear(runner: SqlExecutor, orgId: string, date: string): Promise<number | null> {
  const row = (await runner.execute<{ fiscalYear: number }>(sql`
    select p.fiscal_year as "fiscalYear"
      from accounting_periods p
      join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       and fc.is_default and fc.is_active
     where p.org_id = ${orgId} and not p.is_adjustment
       and p.starts_on <= ${date}::date and p.ends_on >= ${date}::date
     order by p.starts_on, p.ends_on, p.id
     limit 1
  `)).rows[0];
  return row?.fiscalYear ?? null;
}

async function approvedScenario(runner: SqlExecutor, orgId: string, bookId: string, year: number): Promise<Scenario | null> {
  const rows = (await runner.execute<Scenario>(sql`
    select id, name, fiscal_year as "fiscalYear"
      from budget_scenarios
     where org_id = ${orgId} and book_id = ${bookId}
       and fiscal_year = ${year} and kind = 'budget' and status = 'approved'
     order by approved_at desc nulls last, revision desc, id
     for share
  `)).rows;
  if (rows.length > 1) {
    throw fundPostingRefusal({
      message: `More than one approved budget scenario applies to fiscal year ${year} for the primary posting book.`,
      code: "budget_scenario_ambiguous",
      remedy: "Archive the superseded scenario through the budget scenario approval flow, then retry.",
    });
  }
  return rows[0] ?? null;
}

async function balanceWithRunner(runner: SqlExecutor, orgId: string, id: string): Promise<EncumbranceBalance | null> {
  const row = (await runner.execute<{ id: string; amount: string; applied: string }>(sql`
    select e.id, e.amount::text as amount,
           coalesce(sum(case when d.status = 'posted' then dl.amount else 0 end), 0)::text as applied
      from encumbrances e
      left join encumbrance_links l on l.org_id = e.org_id and l.encumbrance_id = e.id
      left join document_lines dl on dl.org_id = l.org_id and dl.id = l.document_line_id
      left join documents d on d.org_id = dl.org_id and d.id = dl.document_id
     where e.org_id = ${orgId} and e.id = ${id}
     group by e.id
  `)).rows[0];
  if (!row) return null;
  const amount = parseMoney(row.amount);
  const appliedActuals = parseMoney(row.applied);
  return { encumbranceId: row.id, amount, appliedActuals, openBalance: subMoney(amount, appliedActuals) };
}

async function audit(runner: SqlExecutor, input: {
  orgId: string; rowId: string; action: string; changes: Record<string, unknown>; actorId?: string | null;
}): Promise<void> {
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'encumbrances', ${input.rowId}, ${input.action},
            ${JSON.stringify(input.changes)}::jsonb, ${input.actorId ?? null})
  `);
}

export async function createEncumbrance(input: CreateEncumbranceInput): Promise<{
  id: string; encumbranceNumber: string; status: EncumbranceStatus;
}> {
  if (input.sourceKind !== "manual" && input.sourceKind !== "purchase_order") {
    throw refuse("The commitment source is not supported.", "encumbrance_source_invalid", "Choose a manual commitment or a purchase order.", 422, "sourceKind");
  }
  if (input.sourceKind === "purchase_order" && !input.sourceId) {
    throw refuse("A purchase order commitment requires its source record.", "encumbrance_source_required", "Choose the purchase order that created this commitment.", 422, "sourceId");
  }
  const amount = positiveAmount(input.amount);
  let dims = validExtraDims(input.extraDims);
  return withOrgTransaction(input.orgId, async () => {
    await requireEnabledForWrite(input.orgId);
    if (typeof dims.fund !== "string") {
      const defaultFund = (await db.execute<{ id: string | null }>(sql`
        select default_value_id as id from segment_definitions
         where org_id = ${input.orgId} and key = 'fund'
           and source_kind = 'custom' and is_active
         limit 1
      `)).rows[0]?.id;
      if (defaultFund) dims = { ...dims, fund: defaultFund };
    }
    const account = (await db.execute<{ id: string; type: string; active: boolean; summary: boolean }>(sql`
      select id, type, is_active as active, is_summary as summary
        from accounts where org_id = ${input.orgId} and id = ${input.accountId}
    `)).rows[0];
    if (!account || !account.active || account.summary || !EXPENSE_TYPES.has(account.type)) {
      throw refuse("The account must be an active expense account in this organization.", "encumbrance_account_invalid", "Choose an active expense account from this organization.", 422, "accountId");
    }
    const cell: Cell = {
      accountId: input.accountId, subsidiaryId: input.subsidiaryId,
      departmentId: input.departmentId ?? null, projectId: input.projectId ?? null,
      locationId: input.locationId ?? null, classId: input.classId ?? null,
      fundId: typeof dims.fund === "string" ? dims.fund : "", extraDims: dims,
    };
    const bookId = await primaryBook(db, input.orgId, null);
    await lockCell(db, input.orgId, bookId, cell);
    const encumbranceNumber = await allocateDocumentNumber(db, input.orgId, "encumbrance", "ENC-");
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into encumbrances
        (org_id, encumbrance_number, source_kind, source_id, account_id, subsidiary_id,
         department_id, project_id, location_id, class_id, extra_dims, amount, status,
         custom, created_by, updated_by)
      values (${input.orgId}, ${encumbranceNumber}, ${input.sourceKind}, ${input.sourceId ?? null},
        ${input.accountId}, ${input.subsidiaryId}, ${cell.departmentId}, ${cell.projectId},
        ${cell.locationId}, ${cell.classId}, ${JSON.stringify(dims)}::jsonb, ${amount},
        'open', ${JSON.stringify(input.custom ?? {})}::jsonb, ${input.actorId ?? null}, ${input.actorId ?? null})
      returning id
    `)).rows[0];
    if (!inserted) {
      throw refuse("The commitment was not created.", "encumbrance_write_missing", "Retry the commitment after checking its account and dimensions.", 409);
    }
    await audit(db, {
      orgId: input.orgId, rowId: inserted.id, action: "insert",
      changes: { after: {
        encumbranceNumber, sourceKind: input.sourceKind, sourceId: input.sourceId ?? null,
        accountId: input.accountId, subsidiaryId: input.subsidiaryId,
        departmentId: cell.departmentId, projectId: cell.projectId, locationId: cell.locationId,
        classId: cell.classId, extraDims: dims, amount, status: "open",
      } },
      actorId: input.actorId,
    });
    return { id: inserted.id, encumbranceNumber, status: "open" };
  });
}

/**
 * Stored subsidiary for route-level scope enforcement. Null when the record
 * is missing or outside the organization — the command boundary answers 404
 * without distinguishing the two.
 */
export async function encumbranceSubsidiaryId(orgId: string, id: string): Promise<string | null> {
  const row = (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from encumbrances where org_id = ${orgId} and id = ${id}
  `)).rows[0];
  return row?.subsidiary_id ?? null;
}

export async function encumbranceOpenBalance(runner: SqlExecutor, orgId: string, id: string): Promise<EncumbranceBalance> {
  await requireEnabledForRead(runner, orgId);
  const balance = await balanceWithRunner(runner, orgId, id);
  if (!balance) {
    throw refuse("The commitment does not exist in this organization.", "encumbrance_missing", "Choose an encumbrance from this organization.", 409);
  }
  return balance;
}

export async function linkEncumbranceDocumentLine(input: {
  orgId: string; encumbranceId: string; documentLineId: string; actorId?: string | null;
}): Promise<{ encumbranceId: string; documentLineId: string }> {
  return withOrgTransaction(input.orgId, async () => {
    await requireEnabledForWrite(input.orgId);
    const e = (await db.execute<{
      id: string; number: string; status: EncumbranceStatus; amount: string;
      accountId: string; subsidiaryId: string; departmentId: string | null;
      projectId: string | null; locationId: string | null; classId: string | null;
      extraDims: Record<string, unknown>;
    }>(sql`
      select id, encumbrance_number as number, status, amount::text as amount,
             account_id as "accountId", subsidiary_id as "subsidiaryId",
             department_id as "departmentId", project_id as "projectId",
             location_id as "locationId", class_id as "classId", extra_dims as "extraDims"
        from encumbrances where org_id = ${input.orgId} and id = ${input.encumbranceId}
       for update
    `)).rows[0];
    if (!e) throw refuse("The commitment does not exist in this organization.", "encumbrance_missing", "Choose an encumbrance from this organization.", 409);
    if (e.status !== "open") {
      throw refuse(`Commitment ${e.number} is ${e.status} and cannot accept linked actuals.`, "encumbrance_state_conflict", "Choose an open commitment or void this commitment.", 409);
    }
    const cell: Cell = {
      accountId: e.accountId, subsidiaryId: e.subsidiaryId,
      departmentId: e.departmentId, projectId: e.projectId, locationId: e.locationId,
      classId: e.classId, fundId: typeof e.extraDims.fund === "string" ? e.extraDims.fund : "",
      extraDims: e.extraDims,
    };
    const bookId = await primaryBook(db, input.orgId, null);
    await lockCell(db, input.orgId, bookId, cell);
    const line = (await db.execute<{ id: string; amount: string }>(sql`
      select dl.id, dl.amount::text as amount
        from document_lines dl
        join documents d on d.org_id = dl.org_id and d.id = dl.document_id
       where dl.org_id = ${input.orgId} and dl.id = ${input.documentLineId}
         and d.status in ('draft', 'pending_approval', 'approved', 'posted')
         and dl.account_id = ${e.accountId}
         and coalesce(dl.subsidiary_id, d.subsidiary_id) = ${e.subsidiaryId}
         and dl.department_id is not distinct from ${e.departmentId}::uuid
         and dl.project_id is not distinct from ${e.projectId}::uuid
         and dl.location_id is not distinct from ${e.locationId}::uuid
         and dl.class_id is not distinct from ${e.classId}::uuid
         and dl.extra_dims = ${JSON.stringify(e.extraDims)}::jsonb
         and dl.amount > 0
    `)).rows[0];
    if (!line) {
      throw refuse(`The document line does not match commitment ${e.number} or its document cannot post.`, "encumbrance_line_mismatch", "Choose a positive expense line with the same account, subsidiary, and dimensions.", 422, "documentLineId");
    }
    const balance = await balanceWithRunner(db, input.orgId, input.encumbranceId);
    const linked = (await db.execute<{ amount: string }>(sql`
      select coalesce(sum(dl.amount), 0)::text as amount
        from encumbrance_links l
        join document_lines dl on dl.org_id = l.org_id and dl.id = l.document_line_id
        join documents d on d.org_id = dl.org_id and d.id = dl.document_id
       where l.org_id = ${input.orgId} and l.encumbrance_id = ${input.encumbranceId}
         -- Live entries only: voided documents cannot reserve an encumbrance balance.
         and d.status in ('draft', 'pending_approval', 'approved', 'posted')
    `)).rows[0]?.amount ?? "0";
    if (!balance || cmpMoney(addMoney(linked, line.amount), balance.openBalance) > 0) {
      throw refuse(`Linking this line would exceed the open balance of commitment ${e.number}.`, "encumbrance_link_exceeds_balance", "Choose a smaller actual line or a commitment with enough open balance.", 422, "documentLineId");
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into encumbrance_links (org_id, encumbrance_id, document_line_id, created_by)
      values (${input.orgId}, ${input.encumbranceId}, ${input.documentLineId}, ${input.actorId ?? null})
      returning document_line_id as id
    `)).rows[0];
    if (!inserted) throw refuse("The actual was not linked to the commitment.", "encumbrance_link_write_missing", "Retry after checking whether the document line is already linked.", 409);
    await audit(db, {
      orgId: input.orgId, rowId: input.encumbranceId, action: "link_actual",
      changes: { before: { openBalance: balance.openBalance }, after: { documentLineId: input.documentLineId, linkedAmount: parseMoney(line.amount) } },
      actorId: input.actorId,
    });
    return { encumbranceId: input.encumbranceId, documentLineId: inserted.id };
  });
}

async function transition(input: {
  orgId: string; encumbranceId: string; status: "closed" | "void"; reason: string; actorId?: string | null;
}): Promise<void> {
  if (!input.reason.trim()) throw refuse("A reason is required.", "encumbrance_reason_required", "Enter why the commitment is changing state.", 422, "reason");
  await withOrgTransaction(input.orgId, async () => {
    await requireEnabledForWrite(input.orgId);
    const row = (await db.execute<{
      number: string; status: EncumbranceStatus; amount: string; accountId: string;
      subsidiaryId: string; departmentId: string | null; projectId: string | null;
      locationId: string | null; classId: string | null; extraDims: Record<string, unknown>;
    }>(sql`
      select encumbrance_number as number, status, amount::text as amount,
             account_id as "accountId", subsidiary_id as "subsidiaryId",
             department_id as "departmentId", project_id as "projectId",
             location_id as "locationId", class_id as "classId", extra_dims as "extraDims"
        from encumbrances where org_id = ${input.orgId} and id = ${input.encumbranceId}
       for update
    `)).rows[0];
    if (!row) throw refuse("The commitment does not exist in this organization.", "encumbrance_missing", "Choose an encumbrance from this organization.", 409);
    const cell: Cell = {
      accountId: row.accountId, subsidiaryId: row.subsidiaryId,
      departmentId: row.departmentId, projectId: row.projectId,
      locationId: row.locationId, classId: row.classId,
      fundId: typeof row.extraDims.fund === "string" ? row.extraDims.fund : "",
      extraDims: row.extraDims,
    };
    const bookId = await primaryBook(db, input.orgId, null);
    await lockCell(db, input.orgId, bookId, cell);
    if (row.status === "void" || row.status === input.status) {
      throw refuse(`Commitment ${row.number} is already ${row.status}.`, "encumbrance_state_conflict", "Refresh the commitment and choose an allowed state transition.", 409);
    }
    if (input.status === "closed") {
      const balance = await balanceWithRunner(db, input.orgId, input.encumbranceId);
      if (!balance || cmpMoney(balance.openBalance, "0.0000") !== 0) {
        throw refuse(
          `Commitment ${row.number} cannot close with open balance ${balance?.openBalance ?? "unavailable"}.`,
          "encumbrance_open_balance",
          "Link the remaining actuals or void the commitment.",
          409,
        );
      }
    }
    const changed = (await db.execute<{ id: string }>(sql`
      update encumbrances set status = ${input.status}, updated_at = now(), updated_by = ${input.actorId ?? null}
       where org_id = ${input.orgId} and id = ${input.encumbranceId} and status = ${row.status}
      returning id
    `)).rows[0];
    if (!changed) throw refuse(`Commitment ${row.number} changed before it could be ${input.status}.`, "encumbrance_state_conflict", "Refresh the commitment and retry the allowed transition.", 409);
    await audit(db, {
      orgId: input.orgId, rowId: input.encumbranceId, action: "update",
      changes: { before: { status: row.status }, after: { status: input.status }, reason: input.reason },
      actorId: input.actorId,
    });
  });
}

export async function closeEncumbrance(input: { orgId: string; encumbranceId: string; reason: string; actorId?: string | null }): Promise<void> {
  return transition({ ...input, status: "closed" });
}

export async function voidEncumbrance(input: { orgId: string; encumbranceId: string; reason: string; actorId?: string | null }): Promise<void> {
  return transition({ ...input, status: "void" });
}

interface PostingBudgetContext {
  bookId: string;
  scenario: Scenario;
}

async function postingBudgetContext(
  runner: SqlExecutor,
  ctx: Pick<BalancingContext, "orgId" | "postingDate" | "bookId">,
): Promise<PostingBudgetContext | null> {
  if (!(await orgFeatureEnabled(ctx.orgId, FEATURE_KEY, runner))) return null;
  const bookId = await primaryBook(runner, ctx.orgId, ctx.bookId);
  if (!bookId) return null;
  const year = await fiscalYear(runner, ctx.orgId, ctx.postingDate);
  if (year === null) return null;
  const scenario = await approvedScenario(runner, ctx.orgId, bookId, year);
  return scenario ? { bookId, scenario } : null;
}

async function fundModes(
  runner: SqlExecutor,
  orgId: string,
  lines: readonly BalancingLineView[],
): Promise<{ defaultFundId: string | null; modes: Map<string, BudgetaryControlMode> }> {
  const explicitIds = [...new Set(lines.flatMap((line) => {
    const value = line.extraDims?.fund;
    return isUuid(value) ? [value] : [];
  }))];
  const result = await runner.execute<{
    defaultFundId: string | null;
    fundId: string | null;
    mode: BudgetaryControlMode | null;
  }>(sql`
    with fund_segment as (
      select org_id, default_value_id
        from segment_definitions
       where org_id = ${orgId} and key = 'fund' and source_kind = 'custom'
         and is_active
    ), requested_values as (
      select unnest(${uuidArray(explicitIds)}::uuid[]) as id
      union
      select default_value_id from fund_segment where default_value_id is not null
    )
    select fs.default_value_id as "defaultFundId", sv.id as "fundId",
           f.budgetary_control as mode
      from fund_segment fs
      left join requested_values rv on true
      left join segment_values sv
        on sv.org_id = fs.org_id and sv.id = rv.id
      left join funds f on f.org_id = sv.org_id and f.id = sv.id
     order by sv.id
  `);
  const modes = new Map<string, BudgetaryControlMode>();
  let defaultFundId: string | null = null;
  for (const row of result.rows) {
    defaultFundId ??= row.defaultFundId;
    if (row.fundId && row.mode) modes.set(row.fundId, row.mode);
  }
  return { defaultFundId, modes };
}

function controlGroups(
  lines: readonly BalancingLineView[],
  accountTypes: ReadonlyMap<string, string>,
  defaultFundId: string | null,
  modes: ReadonlyMap<string, BudgetaryControlMode>,
): ControlGroup[] {
  const groups = new Map<string, ControlGroup>();
  for (const line of lines) {
    if (!EXPENSE_TYPES.has(accountTypes.get(line.accountId) ?? "")) continue;
    const dims = line.extraDims && typeof line.extraDims === "object" ? line.extraDims : {};
    const rawFund = dims.fund;
    const fundId = typeof rawFund === "string" ? rawFund : defaultFundId;
    if (!fundId) continue;
    const mode = modes.get(fundId) ?? "off";
    if (mode === "off") continue;
    const cellDims = typeof rawFund === "string" ? dims : { ...dims, fund: fundId };
    const cell: Cell = {
      accountId: line.accountId,
      subsidiaryId: line.subsidiaryId,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      locationId: line.locationId ?? null,
      classId: line.classId ?? null,
      fundId,
      extraDims: cellDims,
    };
    const key = cellKey(cell);
    const existing = groups.get(key);
    if (existing) existing.amount = addMoney(existing.amount, line.amount);
    else groups.set(key, { cell, mode, amount: parseMoney(line.amount) });
  }
  return [...groups.values()];
}

async function accountTypes(
  runner: SqlExecutor,
  orgId: string,
  lines: readonly BalancingLineView[],
): Promise<Map<string, string>> {
  const ids = [...new Set(lines.map((line) => line.accountId))];
  if (ids.length === 0) return new Map();
  const rows = (await runner.execute<{ id: string; type: string }>(sql`
    select id, type from accounts
     where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])
  `)).rows;
  return new Map(rows.map((row) => [row.id, row.type]));
}

async function cellFiguresForScenario(input: {
  runner: SqlExecutor;
  orgId: string;
  bookId: string;
  postingDate: string;
  scenario: Scenario;
  cell: Cell;
  sourceDocumentId?: string | null;
  pendingAmount?: Money;
}): Promise<BudgetCellFigures | null> {
  const { runner, orgId, bookId, postingDate, scenario, cell } = input;
  const labels = (await runner.execute<{
    accountNumber: string;
    accountName: string;
    fundCode: string;
    fundName: string;
    subsidiaryName: string;
    departmentName: string | null;
    projectName: string | null;
    locationName: string | null;
    className: string | null;
  }>(sql`
    select a.number as "accountNumber", a.name as "accountName",
           sv.code as "fundCode", sv.name as "fundName", s.name as "subsidiaryName",
           d.name as "departmentName", p.name as "projectName",
           l.name as "locationName", c.name as "className"
      from accounts a
      join funds f on f.org_id = a.org_id and f.id = ${cell.fundId}
      join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
      join subsidiaries s on s.org_id = a.org_id and s.id = ${cell.subsidiaryId}
      left join departments d on d.org_id = a.org_id and d.id = ${cell.departmentId}
      left join projects p on p.org_id = a.org_id and p.id = ${cell.projectId}
      left join locations l on l.org_id = a.org_id and l.id = ${cell.locationId}
      left join classes c on c.org_id = a.org_id and c.id = ${cell.classId}
     where a.org_id = ${orgId} and a.id = ${cell.accountId}
  `)).rows[0];
  if (!labels) return null;
  const dims = JSON.stringify(cell.extraDims);
  const appropriationRaw = (await runner.execute<{ amount: string }>(sql`
    select coalesce(sum(bl.amount), 0)::text as amount
      from budget_lines bl
      join accounting_periods p on p.org_id = bl.org_id and p.id = bl.period_id
     where bl.org_id = ${orgId} and bl.scenario_id = ${scenario.id}
       and p.fiscal_year = ${scenario.fiscalYear}
       and bl.account_id = ${cell.accountId}
       and bl.subsidiary_id = ${cell.subsidiaryId}
       and bl.department_id is not distinct from ${cell.departmentId}::uuid
       and bl.project_id is not distinct from ${cell.projectId}::uuid
       and bl.location_id is not distinct from ${cell.locationId}::uuid
       and bl.class_id is not distinct from ${cell.classId}::uuid
       and bl.extra_dims = ${dims}::jsonb
  `)).rows[0]?.amount ?? "0";
  const actualsRaw = (await runner.execute<{ amount: string }>(sql`
    select coalesce(sum(jl.amount), 0)::text as amount
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
      join accounting_periods p on p.org_id = je.org_id and p.id = je.period_id
     where jl.org_id = ${orgId} and je.book_id = ${bookId}
       and je.status in ('posted', 'reversed') and p.fiscal_year = ${scenario.fiscalYear}
       and je.posting_date <= ${postingDate}::date
       and jl.account_id = ${cell.accountId}
       and jl.subsidiary_id = ${cell.subsidiaryId}
       and jl.department_id is not distinct from ${cell.departmentId}::uuid
       and jl.project_id is not distinct from ${cell.projectId}::uuid
       and jl.location_id is not distinct from ${cell.locationId}::uuid
       and jl.class_id is not distinct from ${cell.classId}::uuid
       and jl.extra_dims = ${dims}::jsonb
  `)).rows[0]?.amount ?? "0";
  const openEncumbrancesRaw = (await runner.execute<{ amount: string }>(sql`
    select coalesce(sum(greatest(
      e.amount
      - coalesce((
          select sum(dl.amount)
            from encumbrance_links l
            join document_lines dl on dl.org_id = l.org_id and dl.id = l.document_line_id
            join documents d on d.org_id = dl.org_id and d.id = dl.document_id
           -- Live entries only: only posted, non-voided actuals consume the open balance; the current unposted source is subtracted separately below.
           where l.org_id = e.org_id and l.encumbrance_id = e.id and d.status = 'posted'
        ), 0)
      - coalesce((
          select sum(dl.amount)
            from encumbrance_links l
            join document_lines dl on dl.org_id = l.org_id and dl.id = l.document_line_id
            join documents d on d.org_id = dl.org_id and d.id = dl.document_id
           where l.org_id = e.org_id and l.encumbrance_id = e.id
             and d.id = ${input.sourceDocumentId ?? null}::uuid
             and d.status in ('draft', 'pending_approval', 'approved')
        ), 0),
      0
    )), 0)::text as amount
      from encumbrances e
     where e.org_id = ${orgId} and e.status = 'open'
       and e.account_id = ${cell.accountId}
       and e.subsidiary_id = ${cell.subsidiaryId}
       and e.department_id is not distinct from ${cell.departmentId}::uuid
       and e.project_id is not distinct from ${cell.projectId}::uuid
       and e.location_id is not distinct from ${cell.locationId}::uuid
       and e.class_id is not distinct from ${cell.classId}::uuid
       and e.extra_dims = ${dims}::jsonb
  `)).rows[0]?.amount ?? "0";
  const appropriation = parseMoney(appropriationRaw);
  const actuals = parseMoney(actualsRaw);
  const openEncumbrances = parseMoney(openEncumbrancesRaw);
  const available = subMoney(subMoney(appropriation, actuals), openEncumbrances);
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    accountId: cell.accountId,
    accountNumber: labels.accountNumber,
    accountName: labels.accountName,
    fundId: cell.fundId,
    fundCode: labels.fundCode,
    fundName: labels.fundName,
    subsidiaryId: cell.subsidiaryId,
    subsidiaryName: labels.subsidiaryName,
    departmentId: cell.departmentId,
    departmentName: labels.departmentName,
    projectId: cell.projectId,
    projectName: labels.projectName,
    locationId: cell.locationId,
    locationName: labels.locationName,
    classId: cell.classId,
    className: labels.className,
    extraDims: cell.extraDims,
    appropriation,
    actuals,
    openEncumbrances,
    available: input.pendingAmount ? subMoney(available, input.pendingAmount) : available,
  };
}

/** Read the approved primary-book budget, posted actuals, commitments, and remaining authority for one cell. */
export async function readBudgetCellFigures(
  runner: SqlExecutor,
  input: {
    orgId: string;
    bookId: string | null;
    postingDate: string;
    cell: EncumbranceCellInput & { fundId: string };
  },
): Promise<BudgetCellFigures | null> {
  if (!(await orgFeatureEnabled(input.orgId, FEATURE_KEY, runner))) return null;
  const bookId = await primaryBook(runner, input.orgId, input.bookId);
  if (!bookId) return null;
  const year = await fiscalYear(runner, input.orgId, input.postingDate);
  if (year === null) return null;
  const scenario = await approvedScenario(runner, input.orgId, bookId, year);
  if (!scenario) return null;
  const dims = validExtraDims(input.cell.extraDims);
  const cell: Cell = {
    accountId: input.cell.accountId,
    subsidiaryId: input.cell.subsidiaryId,
    departmentId: input.cell.departmentId ?? null,
    projectId: input.cell.projectId ?? null,
    locationId: input.cell.locationId ?? null,
    classId: input.cell.classId ?? null,
    fundId: input.cell.fundId,
    extraDims: { ...dims, fund: input.cell.fundId },
  };
  return cellFiguresForScenario({
    runner,
    orgId: input.orgId,
    bookId,
    postingDate: input.postingDate,
    scenario,
    cell,
  });
}

/**
 * Budget control is a primary-book policy; secondary-book postings do not
 * consume or refuse against the primary appropriation. The provider is a
 * policy check inside the integrity seam and adds no balancing legs.
 */
export const budgetaryControlProvider: BalancingLegProvider = async (
  runner,
  ctx,
  lines,
): Promise<readonly BalancingLeg[]> => {
  if (ctx.regeneration || lines.length === 0) return [];
  const posting = await postingBudgetContext(runner, ctx);
  if (!posting) return [];
  const types = await accountTypes(runner, ctx.orgId, lines);
  const { defaultFundId, modes } = await fundModes(runner, ctx.orgId, lines);
  const groups = controlGroups(lines, types, defaultFundId, modes);
  for (const group of groups) {
    await lockCell(runner, ctx.orgId, posting.bookId, group.cell);
    const figures = await cellFiguresForScenario({
      runner,
      orgId: ctx.orgId,
      bookId: posting.bookId,
      postingDate: ctx.postingDate,
      scenario: posting.scenario,
      cell: group.cell,
      sourceDocumentId: ctx.sourceDocumentId,
      pendingAmount: group.amount,
    });
    if (!figures || cmpMoney(figures.available, "0.0000") >= 0) continue;
    if (group.mode === "advisory") continue;
    const amountOver = negMoney(figures.available);
    throw fundPostingRefusal({
      status: 422,
      message: "Approved budget \"" + figures.scenarioName + "\" (" + figures.scenarioId +
        ") is exceeded by " + amountOver + " for account " + figures.accountNumber + " " +
        figures.accountName + ", fund " + figures.fundCode + " " + figures.fundName +
        ", subsidiary " + figures.subsidiaryName + ".",
      code: "budget_exceeded",
      remedy: "Revise the budget through its approval flow, or link this actual to the named encumbrance.",
    });
  }
  return [];
};

/** Return advisory overages for a posted entry without changing posting state. */
export async function budgetaryControlWarnings(
  runner: SqlExecutor,
  orgId: string,
  entryId: string,
): Promise<BudgetaryControlWarning[]> {
  if (!(await orgFeatureEnabled(orgId, FEATURE_KEY, runner))) return [];
  const header = (await runner.execute<{
    bookId: string;
    postingDate: string;
    sourceDocumentId: string | null;
    status: string;
  }>(sql`
    select book_id as "bookId", posting_date::text as "postingDate",
           source_document_id as "sourceDocumentId", status
      from journal_entries
     where org_id = ${orgId} and id = ${entryId}
  `)).rows[0];
  if (!header || header.status !== "posted") return [];
  const posting = await postingBudgetContext(runner, {
    orgId,
    postingDate: header.postingDate,
    bookId: header.bookId,
  });
  if (!posting) return [];
  const lines = (await runner.execute<AccountTypeLine>(sql`
    select jl.account_id as "accountId", jl.amount::text as amount,
           jl.subsidiary_id as "subsidiaryId", jl.department_id as "departmentId",
           jl.project_id as "projectId", jl.location_id as "locationId",
           jl.class_id as "classId", jl.currency,
           jl.txn_amount::text as "txnAmount", jl.fx_rate::text as "fxRate",
           jl.extra_dims as "extraDims", a.type
      from journal_lines jl
      join accounts a on a.org_id = jl.org_id and a.id = jl.account_id
     where jl.org_id = ${orgId} and jl.entry_id = ${entryId}
     order by jl.line_number
  `)).rows;
  const types = new Map(lines.map((line) => [line.accountId, line.type]));
  const { defaultFundId, modes } = await fundModes(runner, orgId, lines);
  const warnings: BudgetaryControlWarning[] = [];
  for (const group of controlGroups(lines, types, defaultFundId, modes)) {
    if (group.mode !== "advisory") continue;
    const figures = await cellFiguresForScenario({
      runner,
      orgId,
      bookId: posting.bookId,
      postingDate: header.postingDate,
      scenario: posting.scenario,
      cell: group.cell,
      sourceDocumentId: header.sourceDocumentId,
    });
    if (!figures || cmpMoney(figures.available, "0.0000") >= 0) continue;
    warnings.push({
      ...figures,
      entryId,
      amountOver: negMoney(figures.available),
    });
  }
  return warnings;
}

export interface EncumbranceLinkItem {
  documentLineId: string;
  documentId: string;
  documentNumber: string;
  documentStatus: string;
  amount: string;
}

export interface EncumbranceDetail {
  id: string;
  encumbranceNumber: string;
  sourceKind: EncumbranceSourceKind;
  sourceId: string | null;
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  subsidiaryId: string;
  subsidiaryName: string;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  fundId: string;
  extraDims: Record<string, unknown>;
  amount: string;
  appliedActuals: string;
  openBalance: string;
  status: EncumbranceStatus;
  links: EncumbranceLinkItem[];
  figures: BudgetCellFigures | null;
}

/**
 * Drawer reader: the stored commitment, its open balance, linked actuals,
 * and the appropriation comparison for its cell. Null when the record is
 * missing or outside the organization — the page boundary renders no drawer
 * and the command boundary answers 404.
 */
export async function getEncumbranceDetail(orgId: string, id: string, asOf: string): Promise<EncumbranceDetail | null> {
  return withOrgContext(orgId, async () => {
    await requireEnabledForRead(db, orgId);
    const row = (await db.execute<{
      id: string; encumbrance_number: string; source_kind: EncumbranceSourceKind; source_id: string | null;
      account_id: string; account_number: string | null; account_name: string;
      subsidiary_id: string; subsidiary_name: string;
      department_id: string | null; project_id: string | null; location_id: string | null; class_id: string | null;
      extra_dims: Record<string, unknown>; amount: string; status: EncumbranceStatus;
    }>(sql`
      select e.id, e.encumbrance_number, e.source_kind, e.source_id,
             e.account_id, a.number as account_number, a.name as account_name,
             e.subsidiary_id, s.name as subsidiary_name,
             e.department_id::text as department_id, e.project_id::text as project_id,
             e.location_id::text as location_id, e.class_id::text as class_id,
             e.extra_dims, e.amount::text as amount, e.status
        from encumbrances e
        join accounts a on a.org_id = e.org_id and a.id = e.account_id
        join subsidiaries s on s.org_id = e.org_id and s.id = e.subsidiary_id
       where e.org_id = ${orgId} and e.id = ${id}
    `)).rows[0];
    if (!row) return null;
    const balance = await balanceWithRunner(db, orgId, id);
    if (!balance) return null;
    const links = (await db.execute<{
      document_line_id: string; document_id: string; document_number: string; document_status: string; amount: string;
    }>(sql`
      select l.document_line_id, dl.document_id, d.document_number, d.status as document_status,
             dl.amount::text as amount
        from encumbrance_links l
        join document_lines dl on dl.org_id = l.org_id and dl.id = l.document_line_id
        join documents d on d.org_id = dl.org_id and d.id = dl.document_id
       where l.org_id = ${orgId} and l.encumbrance_id = ${id}
       order by d.document_number, l.document_line_id
    `)).rows;
    const fundId = typeof row.extra_dims.fund === "string" ? row.extra_dims.fund : "";
    const figures = fundId
      ? await readBudgetCellFigures(db, {
          orgId, bookId: null, postingDate: asOf,
          cell: {
            accountId: row.account_id, subsidiaryId: row.subsidiary_id,
            departmentId: row.department_id, projectId: row.project_id,
            locationId: row.location_id, classId: row.class_id,
            fundId, extraDims: row.extra_dims,
          },
        })
      : null;
    return {
      id: row.id, encumbranceNumber: row.encumbrance_number, sourceKind: row.source_kind, sourceId: row.source_id,
      accountId: row.account_id, accountNumber: row.account_number, accountName: row.account_name,
      subsidiaryId: row.subsidiary_id, subsidiaryName: row.subsidiary_name,
      departmentId: row.department_id, projectId: row.project_id,
      locationId: row.location_id, classId: row.class_id, fundId,
      extraDims: row.extra_dims,
      amount: row.amount, appliedActuals: balance.appliedActuals, openBalance: balance.openBalance,
      status: row.status,
      links: links.map((link) => ({
        documentLineId: link.document_line_id, documentId: link.document_id,
        documentNumber: link.document_number, documentStatus: link.document_status, amount: link.amount,
      })),
      figures,
    };
  });
}

const ENCUMBRANCE_STATUSES: EncumbranceStatus[] = ["open", "closed", "void"];

export interface EncumbranceListItem {
  id: string;
  encumbranceNumber: string;
  sourceKind: EncumbranceSourceKind;
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  subsidiaryId: string;
  subsidiaryName: string;
  amount: string;
  status: EncumbranceStatus;
}

export interface ListEncumbrancesInput {
  orgId: string;
  status?: EncumbranceStatus | EncumbranceStatus[];
  subsidiaryId?: string;
  accountId?: string;
  q?: string;
  limit?: number;
  offset?: number;
  /**
   * Server-owned caller scope. Null reads unrestricted; an empty list reads
   * nothing; otherwise only rows whose stored subsidiary is listed are
   * returned, with the same-scope total. The stored subsidiary stays the
   * authority — this reader performs no post-filtering.
   */
  allowedSubsidiaryIds: readonly string[] | null;
}

/**
 * Collection reader for the encumbrance register. Rows carry their stored
 * subsidiary, and the caller allowlist scopes both rows and total to it, so
 * route and page boundaries consume this reader directly — never a
 * post-filter or a parallel query.
 */
export async function listEncumbrances(input: ListEncumbrancesInput): Promise<{ items: EncumbranceListItem[]; total: number }> {
  const statuses = input.status === undefined ? [] : Array.isArray(input.status) ? input.status : [input.status];
  for (const status of statuses) {
    if (!ENCUMBRANCE_STATUSES.includes(status)) {
      throw refuse("The commitment status filter is not supported.", "encumbrance_status_invalid", "Filter by an open, closed, or void commitment state.", 422, "status");
    }
  }
  if (input.subsidiaryId !== undefined && !isUuid(input.subsidiaryId)) {
    throw refuse("The subsidiary filter must identify a valid record.", "encumbrance_subsidiary_invalid", "Choose a subsidiary from this organization.", 422, "subsidiaryId");
  }
  if (input.accountId !== undefined && !isUuid(input.accountId)) {
    throw refuse("The account filter must identify a valid record.", "encumbrance_account_filter_invalid", "Choose an expense account from this organization.", 422, "accountId");
  }
  if (!Object.hasOwn(input, 'allowedSubsidiaryIds') || (input.allowedSubsidiaryIds !== null && !Array.isArray(input.allowedSubsidiaryIds))) {
    throw refuse("Subsidiary scope is required.", "encumbrance_scope_required", "Call with null for unrestricted scope, an empty list for no access, or the caller's allowed subsidiaries.", 422, "allowedSubsidiaryIds");
  }
  const allowlist = input.allowedSubsidiaryIds;
  if (allowlist !== null) {
    for (const id of allowlist) {
      if (!isUuid(id)) {
        throw refuse("The subsidiary scope must identify valid records.", "encumbrance_scope_invalid", "Call with the caller's allowed subsidiaries, null for unrestricted scope, or an empty list for no access.", 422, "allowedSubsidiaryIds");
      }
    }
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  const q = input.q?.trim() ? `%${input.q.trim()}%` : null;
  return withOrgContext(input.orgId, async () => {
    await requireEnabledForRead(db, input.orgId);
    const rows = await db.execute<{
      id: string; encumbrance_number: string; source_kind: EncumbranceSourceKind;
      account_id: string; account_number: string | null; account_name: string;
      subsidiary_id: string; subsidiary_name: string;
      amount: string; status: EncumbranceStatus; total: number;
    }>(sql`
      with filtered as (
        select e.id, e.encumbrance_number, e.source_kind,
               e.account_id, a.number as account_number, a.name as account_name,
               e.subsidiary_id, s.name as subsidiary_name,
               e.amount::text as amount, e.status
          from encumbrances e
          join accounts a on a.org_id = e.org_id and a.id = e.account_id
          join subsidiaries s on s.org_id = e.org_id and s.id = e.subsidiary_id
         where e.org_id = ${input.orgId}
           and (${statuses.length === 0 ? sql`true` : sql`e.status = any(${`{${statuses.join(",")}}`}::text[])`})
           and (${input.subsidiaryId ?? null}::uuid is null or e.subsidiary_id = ${input.subsidiaryId ?? null}::uuid)
           and (${input.accountId ?? null}::uuid is null or e.account_id = ${input.accountId ?? null}::uuid)
           and (${allowlist === null ? sql`true` : sql`e.subsidiary_id = any(${uuidArray(allowlist)}::uuid[])`})
           and (${q ?? null}::text is null or e.encumbrance_number ilike ${q ?? null}::text)
      ),
      page as (
        select * from filtered order by encumbrance_number limit ${limit} offset ${offset}
      ),
      scope_total as (
        select count(*)::int as total from filtered
      )
      select page.*, (select total from scope_total) as total from page
      union all
      select null, null, null, null, null, null, null, null, null, null, (select total from scope_total)
       where not exists (select 1 from page)
    `);
    return {
      items: rows.rows.filter((row) => row.id !== null).map((row) => ({
        id: row.id, encumbranceNumber: row.encumbrance_number, sourceKind: row.source_kind,
        accountId: row.account_id, accountNumber: row.account_number, accountName: row.account_name,
        subsidiaryId: row.subsidiary_id, subsidiaryName: row.subsidiary_name,
        amount: row.amount, status: row.status,
      })),
      total: rows.rows[0]?.total ?? 0,
    };
  });
}
