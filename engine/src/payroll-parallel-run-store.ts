import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../../web/lib/exact-decimal.ts";
import { db } from "./db.ts";
import { cmp, isZero, normalizeMoney } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  auditComparison,
  comparePriorPayrollPeriod,
  componentSlot,
  difference,
  EXACT,
  slotKey,
  TOTAL_SLOTS,
  TOTAL_SLOT_EMPLOYER_COST,
  TOTAL_SLOT_GROSS,
  TOTAL_SLOT_NET,
  type ParallelAmount,
  type ParallelComparison,
  type ParallelEmployeeSide,
  type ParallelFindingKind,
  type ParallelSide,
  type ParallelSlotKind,
  type ParallelTolerance,
  type UnmappedSourceColumn,
} from "./payroll-parallel-run.ts";

/**
 * The persistence and read layer around the pure parallel-run comparison.
 *
 * The comparison itself lives in `payroll-parallel-run.ts` and touches nothing —
 * no database, no clock, no configuration — because that is the only way its
 * own correctness is checkable. This module is the boundary: it reads the two
 * sides out of the tenant, hands them to the comparison, audits the result, and
 * files it as evidence.
 *
 * Two rules the boundary enforces and the pure core cannot:
 *
 *  1. A comparison that fails `auditComparison` is REFUSED, not stored. The
 *     whole purpose of a parallel run is to be believable; a result that cannot
 *     vouch for itself must never become a row someone later cites.
 *  2. Our side is read from `pay_stubs` + `pay_stub_lines`, aggregated per
 *     (kind, component), because a job-costed wage or employer burden is
 *     legitimately several lines for one component. Comparing line by line
 *     would manufacture differences that are not there.
 */

const MAX_REGISTER_ROWS = 50_000;

export class ParallelRunStoreError extends PayrollError {}

/* ------------------------------------------------------------------ */
/* The comparable slot vocabulary                                      */
/* ------------------------------------------------------------------ */

/**
 * One thing a prior provider's column can be mapped onto.
 *
 * The vocabulary is the org's OWN `pay_components`, plus the three stated
 * totals. It is resolved from the database rather than declared here so a
 * country pack, a union fringe, or a user component becomes comparable the
 * moment it exists — nothing about this module knows a jurisdiction.
 */
export interface ComparableSlot {
  /** Import field key: the component code, or a reserved `total:` key. */
  fieldKey: string;
  kind: ParallelFindingKind;
  /** Stable comparison slot (system key, `code:CODE`, or a total key). */
  slot: string;
  label: string;
  componentId: string | null;
  systemKey: string | null;
  code: string | null;
}

/** Reserved import field keys for a register's own stated totals. */
export const TOTAL_FIELD_KEYS: Record<string, string> = {
  "total:gross": TOTAL_SLOT_GROSS,
  "total:net_pay": TOTAL_SLOT_NET,
  "total:employer_cost": TOTAL_SLOT_EMPLOYER_COST,
};

const TOTAL_SLOT_LABELS: Record<string, string> = {
  [TOTAL_SLOT_GROSS]: "Gross pay (as the prior system stated it)",
  [TOTAL_SLOT_NET]: "Net pay (as the prior system stated it)",
  [TOTAL_SLOT_EMPLOYER_COST]: "Employer cost (as the prior system stated it)",
};

const KIND_LABELS: Record<ParallelSlotKind, string> = {
  earning: "earning",
  deduction: "deduction",
  employer_contribution: "employer contribution",
};

/**
 * Every slot this org can compare, in stub order.
 *
 * The three stated totals come first and are marked required on import: a
 * register that does not state its own gross and net cannot be reconciled
 * against its components, which is the structural guard that catches a column
 * nobody mapped.
 */
export async function comparableSlots(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<ComparableSlot[]> {
  const rows = (await runner.execute<{
      id: string; code: string; name: string; kind: ParallelSlotKind;
      system_key: string | null; sequence: number;
    }>(sql`
    select c.id, c.code, c.name, c.kind, c.system_key, c.sequence
      from pay_components c
     where c.org_id = ${orgId}
     order by case c.kind when 'earning' then 1 when 'deduction' then 2 else 3 end,
              c.sequence, c.code
  `));

  const totals: ComparableSlot[] = Object.entries(TOTAL_FIELD_KEYS).map(([fieldKey, slot]) => ({
    fieldKey,
    kind: "total" as const,
    slot,
    label: TOTAL_SLOT_LABELS[slot]!,
    componentId: null,
    systemKey: null,
    code: null,
  }));

  return [
    ...totals,
    ...rows.rows.map((row) => ({
      // The component CODE is the import field key: it is unique per org, so a
      // file column maps onto exactly one component. A system key is not — the
      // employee and employer sides of one statutory kind share it.
      fieldKey: row.code,
      kind: row.kind,
      slot: componentSlot(row.system_key, row.code),
      label: `${row.name} (${KIND_LABELS[row.kind]}) — ${row.code}`,
      componentId: row.id,
      systemKey: row.system_key,
      code: row.code,
    })),
  ];
}

/** Slot display labels keyed the way the comparison wants them. */
export function slotLabelMap(slots: readonly ComparableSlot[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const slot of slots) labels[slotKey(slot.kind, slot.slot)] = slot.label;
  for (const [slot, label] of Object.entries(TOTAL_SLOT_LABELS)) {
    labels[slotKey("total", slot)] ??= label;
  }
  return labels;
}

/* ------------------------------------------------------------------ */
/* Prior registers — the imported side                                 */
/* ------------------------------------------------------------------ */

export interface PriorRegisterHeader {
  id: string;
  name: string;
  providerName: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  currencyCode: string | null;
  sourceFileName: string | null;
  unmappedColumns: UnmappedSourceColumn[];
  employeeCount: number;
  amountCount: number;
  statedGross: string;
  statedNet: string;
  updatedAt: string | null;
}

export interface PriorRegisterUpsert {
  orgId: string;
  actorId: string;
  name: string;
  providerName?: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  currencyCode?: string | null;
  sourceFileName?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: unknown, field: string): string {
  const raw = String(value ?? "").trim().slice(0, 10);
  if (!ISO_DATE.test(raw)) throw new ParallelRunStoreError(`${field} must be a date (YYYY-MM-DD)`);
  return raw;
}

/**
 * Find or create the register a set of imported rows belongs to.
 *
 * Keyed on the operator's name so a re-import of the same file lands in the
 * same register rather than silently creating a second one that a comparison
 * might then pick instead.
 */
export async function upsertPriorRegister(
  input: PriorRegisterUpsert,
  runner: Pick<typeof db, "execute"> = db,
): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new ParallelRunStoreError("a prior register needs a name");
  const periodStart = assertDate(input.periodStart, "periodStart");
  const periodEnd = assertDate(input.periodEnd, "periodEnd");
  const payDate = assertDate(input.payDate, "payDate");
  if (periodEnd < periodStart) {
    throw new ParallelRunStoreError("periodEnd cannot fall before periodStart");
  }

  const result = (await runner.execute<{ id: string }>(sql`
    insert into payroll_prior_registers
      (org_id, name, provider_name, period_start, period_end, pay_date,
       currency_code, source_file_name, created_by, updated_by)
    values (${input.orgId}, ${name}, ${input.providerName ?? null},
            ${periodStart}, ${periodEnd}, ${payDate},
            ${input.currencyCode ?? null}, ${input.sourceFileName ?? null},
            ${input.actorId}, ${input.actorId})
    on conflict (org_id, name) do update set
      provider_name = coalesce(excluded.provider_name, payroll_prior_registers.provider_name),
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      pay_date = excluded.pay_date,
      currency_code = coalesce(excluded.currency_code, payroll_prior_registers.currency_code),
      source_file_name = coalesce(excluded.source_file_name, payroll_prior_registers.source_file_name),
      updated_at = now(),
      updated_by = excluded.updated_by
    returning id`));
  const id = result.rows[0]?.id;
  if (!id) throw new ParallelRunStoreError("the prior register could not be saved");
  return id;
}

/**
 * Record the source columns nobody mapped.
 *
 * MERGED, never replaced: an import run in two passes must not let the second
 * pass erase what the first one noticed. The count is the higher of the two,
 * because "this column carried a value in four rows" is a floor on how much
 * money is unaccounted for.
 */
export async function recordUnmappedColumns(
  orgId: string,
  registerId: string,
  columns: readonly UnmappedSourceColumn[],
  runner: Pick<typeof db, "execute"> = db,
): Promise<void> {
  const existing = await priorRegisterUnmappedColumns(orgId, registerId, runner);
  const merged = new Map(existing.map((column) => [column.column, column.valuedRows]));
  for (const column of columns) {
    const name = column.column.trim();
    if (!name) continue;
    merged.set(name, Math.max(merged.get(name) ?? 0, column.valuedRows));
  }
  const payload = [...merged.entries()]
    .map(([column, valuedRows]) => ({ column, valuedRows }))
    .sort((a, b) => a.column.localeCompare(b.column));
  await runner.execute(sql`
    update payroll_prior_registers
       set unmapped_columns = ${JSON.stringify(payload)}::jsonb, updated_at = now()
     where org_id = ${orgId} and id = ${registerId}`);
}

async function priorRegisterUnmappedColumns(
  orgId: string,
  registerId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<UnmappedSourceColumn[]> {
  const rows = (await runner.execute<{ unmapped_columns: unknown }>(sql`
    select unmapped_columns from payroll_prior_registers
     where org_id = ${orgId} and id = ${registerId}`));
  return parseUnmapped(rows.rows[0]?.unmapped_columns);
}

function parseUnmapped(raw: unknown): UnmappedSourceColumn[] {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const row = entry as { column?: unknown; valuedRows?: unknown };
      const column = String(row?.column ?? "").trim();
      const valuedRows = Number.isFinite(row?.valuedRows as number)
        ? Math.trunc(row!.valuedRows as number)
        : 0;
      return { column, valuedRows };
    })
    .filter((entry) => entry.column.length > 0);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface PriorStubWrite {
  employeePartyId: string;
  employeeLabel: string;
  gross: string | null;
  netPay: string | null;
  employerCost: string | null;
  /** Component amounts, keyed by the slot's import field key. */
  amounts: { fieldKey: string; amount: string; sourceColumn: string | null }[];
}

/**
 * Write one employee's prior-system row.
 *
 * Idempotent per (register, employee): re-importing a corrected file replaces
 * that employee's amounts wholesale rather than merging two versions of the
 * truth. A slot that vanished from the corrected file must vanish here, or the
 * comparison would keep reporting an amount nobody claims any more.
 */
export async function savePriorStub(
  input: { orgId: string; actorId: string; registerId: string; row: PriorStubWrite },
  slots: readonly ComparableSlot[],
  runner: Pick<typeof db, "execute"> = db,
): Promise<{ created: boolean }> {
  const bySlotField = new Map(slots.map((slot) => [slot.fieldKey, slot]));
  const label = input.row.employeeLabel.trim() || input.row.employeePartyId;

  const money = (value: string | null, field: string): string | null => {
    if (value === null || String(value).trim() === "") return null;
    const exact = canonicalDecimal(String(value).replace(/[$,\s]/g, ""), 4);
    if (exact === null) throw new ParallelRunStoreError(`${field} is not an amount: "${value}"`);
    try {
      return normalizeMoney(exact);
    } catch {
      throw new ParallelRunStoreError(`${field} is not an amount: "${value}"`);
    }
  };

  const existing = (await runner.execute<{ id: string }>(sql`
    select id from payroll_prior_stubs
     where org_id = ${input.orgId} and register_id = ${input.registerId}
       and employee_party_id = ${input.row.employeePartyId}`));
  const created = existing.rows.length === 0;

  const upserted = (await runner.execute<{ id: string }>(sql`
    insert into payroll_prior_stubs
      (org_id, register_id, employee_party_id, employee_label, gross, net_pay,
       employer_cost, created_by, updated_by)
    values (${input.orgId}, ${input.registerId}, ${input.row.employeePartyId}, ${label},
            ${money(input.row.gross, "gross")}, ${money(input.row.netPay, "netPay")},
            ${money(input.row.employerCost, "employerCost")},
            ${input.actorId}, ${input.actorId})
    on conflict (register_id, employee_party_id) do update set
      employee_label = excluded.employee_label,
      gross = excluded.gross,
      net_pay = excluded.net_pay,
      employer_cost = excluded.employer_cost,
      updated_at = now(),
      updated_by = excluded.updated_by
    where payroll_prior_stubs.org_id = ${input.orgId}
    returning id`));
  const stubId = upserted.rows[0]!.id;

  await runner.execute(sql`
    delete from payroll_prior_amounts
     where org_id = ${input.orgId} and prior_stub_id = ${stubId}`);

  for (const amount of input.row.amounts) {
    const slot = bySlotField.get(amount.fieldKey);
    if (!slot) {
      throw new ParallelRunStoreError(`"${amount.fieldKey}" is not a comparable component`);
    }
    if (slot.kind === "total") continue;
    const value = money(amount.amount, amount.fieldKey);
    if (value === null) continue;
    await runner.execute(sql`
      insert into payroll_prior_amounts
        (org_id, prior_stub_id, component_id, kind, slot, source_column, amount,
         created_by, updated_by)
      values (${input.orgId}, ${stubId}, ${slot.componentId}, ${slot.kind}, ${slot.slot},
              ${amount.sourceColumn}, ${value}, ${input.actorId}, ${input.actorId})
      on conflict (prior_stub_id, kind, slot) do update set
        amount = excluded.amount,
        component_id = excluded.component_id,
        source_column = excluded.source_column,
        updated_at = now(),
        updated_by = excluded.updated_by
      where payroll_prior_amounts.org_id = ${input.orgId}`);
  }

  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'payroll_prior_stubs', ${stubId}, ${created ? "insert" : "update"},
            ${JSON.stringify({
              registerId: input.registerId,
              employeeLabel: label,
              gross: input.row.gross,
              netPay: input.row.netPay,
              amounts: input.row.amounts.length,
              source: "parallel-run import",
            })}, ${input.actorId})`);

  return { created };
}

/** Every imported register, newest period first, with what it actually holds. */
export async function priorRegisters(orgId: string): Promise<PriorRegisterHeader[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select r.id, r.name, r.provider_name, r.period_start::text as period_start,
           r.period_end::text as period_end, r.pay_date::text as pay_date,
           r.currency_code, r.source_file_name, r.unmapped_columns,
           r.updated_at::text as updated_at,
           (select count(*)::int from payroll_prior_stubs s
             where s.register_id = r.id and s.org_id = r.org_id) as employee_count,
           (select count(*)::int from payroll_prior_amounts a
              join payroll_prior_stubs s on s.id = a.prior_stub_id and s.org_id = a.org_id
             where s.register_id = r.id and a.org_id = r.org_id) as amount_count,
           (select coalesce(sum(s.gross), 0) from payroll_prior_stubs s
             where s.register_id = r.id and s.org_id = r.org_id) as stated_gross,
           (select coalesce(sum(s.net_pay), 0) from payroll_prior_stubs s
             where s.register_id = r.id and s.org_id = r.org_id) as stated_net
      from payroll_prior_registers r
     where r.org_id = ${orgId}
     order by r.pay_date desc, r.name
     limit 500`));

  return rows.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    providerName: row.provider_name == null ? null : String(row.provider_name),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    payDate: String(row.pay_date),
    currencyCode: row.currency_code == null ? null : String(row.currency_code),
    sourceFileName: row.source_file_name == null ? null : String(row.source_file_name),
    unmappedColumns: parseUnmapped(row.unmapped_columns),
    employeeCount: asCount(row.employee_count),
    amountCount: asCount(row.amount_count),
    statedGross: normalizeMoney(String(row.stated_gross ?? "0")),
    statedNet: normalizeMoney(String(row.stated_net ?? "0")),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  }));
}

function asCount(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "0"), 10);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

export async function deletePriorRegister(
  orgId: string,
  registerId: string,
  actorId: string,
): Promise<void> {
  await db.execute(sql`
    delete from payroll_parallel_findings
     where org_id = ${orgId} and comparison_id in (
       select id from payroll_parallel_comparisons
        where org_id = ${orgId} and register_id = ${registerId})`);
  await db.execute(sql`
    delete from payroll_parallel_comparisons
     where org_id = ${orgId} and register_id = ${registerId}`);
  await db.execute(sql`
    delete from payroll_prior_amounts
     where org_id = ${orgId} and prior_stub_id in (
       select id from payroll_prior_stubs
        where org_id = ${orgId} and register_id = ${registerId})`);
  await db.execute(sql`
    delete from payroll_prior_stubs where org_id = ${orgId} and register_id = ${registerId}`);
  await db.execute(sql`
    delete from payroll_prior_registers where org_id = ${orgId} and id = ${registerId}`);
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'payroll_prior_registers', ${registerId}, 'delete',
            ${JSON.stringify({ reason: "operator discarded the imported register" })}, ${actorId})`);
}

/* ------------------------------------------------------------------ */
/* Loading the two sides                                               */
/* ------------------------------------------------------------------ */

/** The prior register as one side of a comparison. */
export async function loadPriorSide(
  orgId: string,
  registerId: string,
): Promise<ParallelSide & { unmappedColumns: UnmappedSourceColumn[] }> {
  const header = (await db.execute<{ name: string; unmapped_columns: unknown }>(sql`
    select name, unmapped_columns from payroll_prior_registers
     where org_id = ${orgId} and id = ${registerId}`));
  const register = header.rows[0];
  if (!register) throw new ParallelRunStoreError("that prior register does not exist");

  const stubs = (await db.execute<Record<string, unknown>>(sql`
    select s.id, s.employee_party_id, s.employee_label, s.gross, s.net_pay, s.employer_cost,
           coalesce(p.display_name, s.employee_label) as employee_name
      from payroll_prior_stubs s
      left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.register_id = ${registerId}
     order by employee_name
     limit ${MAX_REGISTER_ROWS}`));

  const amounts = (await db.execute<Record<string, unknown>>(sql`
    select a.prior_stub_id, a.kind, a.slot, a.amount, a.source_column
      from payroll_prior_amounts a
      join payroll_prior_stubs s on s.id = a.prior_stub_id and s.org_id = a.org_id
     where a.org_id = ${orgId} and s.register_id = ${registerId}
     order by a.slot`));

  const bySt = new Map<string, ParallelAmount[]>();
  for (const row of amounts.rows) {
    const stubId = String(row.prior_stub_id);
    const list = bySt.get(stubId) ?? [];
    list.push({
      kind: String(row.kind) as ParallelSlotKind,
      slot: String(row.slot),
      amount: normalizeMoney(String(row.amount)),
      sourceColumn: row.source_column == null ? null : String(row.source_column),
    });
    bySt.set(stubId, list);
  }

  return {
    label: register.name,
    unmappedColumns: parseUnmapped(register.unmapped_columns),
    employees: stubs.rows.map((row) => ({
      employeePartyId: String(row.employee_party_id),
      employeeName: String(row.employee_name),
      gross: row.gross == null ? null : normalizeMoney(String(row.gross)),
      netPay: row.net_pay == null ? null : normalizeMoney(String(row.net_pay)),
      employerCost: row.employer_cost == null ? null : normalizeMoney(String(row.employer_cost)),
      amounts: bySt.get(String(row.id)) ?? [],
    })),
  };
}

/**
 * Our own run as the other side.
 *
 * Aggregated per (employee, kind, component) in SQL because job-costed wages
 * and project-split employer burdens are several `pay_stub_lines` rows for one
 * component. Reading `run_status in ('calculated','committed')` is deliberate:
 * the entire point of a parallel run is to check the numbers BEFORE the money
 * leaves, so a calculated-but-uncommitted run must be comparable.
 */
export async function loadOurSide(
  orgId: string,
  payRunDocumentId: string,
): Promise<ParallelSide> {
  const header = (await db.execute<{ label: string; run_status: string }>(sql`
    select coalesce(d.document_number, r.document_id::text) as label,
           r.run_status, r.period_start::text as period_start,
           r.period_end::text as period_end, r.pay_date::text as pay_date
      from pay_runs r
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${payRunDocumentId}`));
  const run = header.rows[0];
  if (!run) throw new ParallelRunStoreError("that pay run does not exist");
  if (run.run_status === "draft") {
    // A draft run has no stubs at all, so comparing against it would produce a
    // population mismatch dressed up as a reconciliation. Refuse plainly.
    throw new ParallelRunStoreError(
      `pay run ${run.label} has not been calculated yet — there is nothing to compare against`,
    );
  }
  if (run.run_status === "voided") {
    throw new ParallelRunStoreError(`pay run ${run.label} is voided`);
  }

  const stubs = (await db.execute<Record<string, unknown>>(sql`
    select s.id, s.employee_party_id, p.display_name as employee_name,
           s.gross, s.net_pay, s.employer_cost
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${payRunDocumentId}
     order by p.display_name`));

  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.stub_id, l.kind,
           coalesce(c.system_key, 'code:' || c.code, 'code:' || l.description) as slot,
           sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${orgId} and s.pay_run_document_id = ${payRunDocumentId}
     group by l.stub_id, l.kind, coalesce(c.system_key, 'code:' || c.code, 'code:' || l.description)
     order by slot`));

  const byStub = new Map<string, ParallelAmount[]>();
  for (const row of lines.rows) {
    const stubId = String(row.stub_id);
    const list = byStub.get(stubId) ?? [];
    list.push({
      kind: String(row.kind) as ParallelSlotKind,
      slot: String(row.slot),
      amount: normalizeMoney(String(row.amount)),
    });
    byStub.set(stubId, list);
  }

  return {
    label: run.label,
    employees: stubs.rows.map((row): ParallelEmployeeSide => ({
      employeePartyId: String(row.employee_party_id),
      employeeName: String(row.employee_name),
      gross: normalizeMoney(String(row.gross ?? "0")),
      netPay: normalizeMoney(String(row.net_pay ?? "0")),
      employerCost: normalizeMoney(String(row.employer_cost ?? "0")),
      amounts: byStub.get(String(row.id)) ?? [],
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Tolerances                                                          */
/* ------------------------------------------------------------------ */

/** Configured allowances. An empty result — the default — means exact. */
export async function parallelTolerances(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<(ParallelTolerance & { id: string })[]> {
  const rows = (await runner.execute<{ id: string; kind: string; slot: string; tolerance: string; reason: string }>(sql`
    select id, kind, slot, tolerance, reason from payroll_parallel_tolerances
     where org_id = ${orgId} order by kind, slot`));
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind as ParallelFindingKind,
    slot: row.slot,
    tolerance: normalizeMoney(String(row.tolerance)),
    reason: row.reason,
  }));
}

export async function saveParallelTolerance(input: {
  orgId: string;
  actorId: string;
  kind: ParallelFindingKind;
  slot: string;
  tolerance: string;
  reason: string;
}): Promise<void> {
  const tolerance = normalizeMoney(input.tolerance);
  if (cmp(tolerance, "0") < 0) {
    throw new ParallelRunStoreError("a tolerance cannot be negative");
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new ParallelRunStoreError(
      "a tolerance needs a reason — agreeing to stop looking at a difference has to be attributable",
    );
  }
  if (!input.slot.trim()) throw new ParallelRunStoreError("a tolerance needs a slot");

  // Zero is the default, so storing a zero row is storing nothing. Remove it
  // instead, and keep the disclosure list free of entries that do nothing.
  if (isZero(tolerance)) {
    await deleteParallelTolerance(input.orgId, input.kind, input.slot, input.actorId);
    return;
  }

  const row = (await db.execute<{ id: string }>(sql`
    insert into payroll_parallel_tolerances
      (org_id, kind, slot, tolerance, reason, created_by, updated_by)
    values (${input.orgId}, ${input.kind}, ${input.slot}, ${tolerance}, ${reason},
            ${input.actorId}, ${input.actorId})
    on conflict (org_id, kind, slot) do update set
      tolerance = excluded.tolerance, reason = excluded.reason,
      updated_at = now(), updated_by = excluded.updated_by
    returning id`));

  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'payroll_parallel_tolerances', ${row.rows[0]!.id}, 'update',
            ${JSON.stringify({ kind: input.kind, slot: input.slot, tolerance, reason })},
            ${input.actorId})`);
}

export async function deleteParallelTolerance(
  orgId: string,
  kind: ParallelFindingKind,
  slot: string,
  actorId: string,
): Promise<void> {
  const removed = (await db.execute<{ id: string }>(sql`
    delete from payroll_parallel_tolerances
     where org_id = ${orgId} and kind = ${kind} and slot = ${slot}
    returning id`));
  const id = removed.rows[0]?.id;
  if (!id) return;
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'payroll_parallel_tolerances', ${id}, 'delete',
            ${JSON.stringify({ kind, slot, effect: "this slot now compares exactly" })}, ${actorId})`);
}

/* ------------------------------------------------------------------ */
/* Running and filing a comparison                                     */
/* ------------------------------------------------------------------ */

export interface RunParallelComparisonInput {
  orgId: string;
  actorId: string;
  registerId: string;
  payRunDocumentId: string;
}

export interface FiledComparison {
  comparisonId: string;
  comparison: ParallelComparison;
}

/**
 * Compare, audit, then file.
 *
 * The audit runs BEFORE the write and a failure aborts it. A comparison that
 * cannot vouch for its own arithmetic or that would report a clean result off
 * an empty population is a defect in this module, and the correct behaviour is
 * to refuse to produce evidence rather than to produce misleading evidence.
 */
export async function runParallelComparison(
  input: RunParallelComparisonInput,
): Promise<FiledComparison> {
  const slots = await comparableSlots(input.orgId);
  const [prior, ours, tolerances] = await Promise.all([
    loadPriorSide(input.orgId, input.registerId),
    loadOurSide(input.orgId, input.payRunDocumentId),
    parallelTolerances(input.orgId),
  ]);

  const comparison = comparePriorPayrollPeriod({
    prior,
    ours,
    tolerances: tolerances.map(({ kind, slot, tolerance, reason }) => ({
      kind, slot, tolerance, reason,
    })),
    slotLabels: slotLabelMap(slots),
  });

  const failures = auditComparison(comparison);
  if (failures.length > 0) {
    throw new ParallelRunStoreError(
      `the comparison failed its own self-check and was not filed: ${failures
        .map((failure) => `${failure.invariant} — ${failure.detail}`)
        .join("; ")}`,
    );
  }

  const header = (await db.execute<{ id: string }>(sql`
    insert into payroll_parallel_comparisons
      (org_id, register_id, pay_run_document_id, status,
       prior_employee_count, our_employee_count, compared_employee_count,
       prior_only_employee_count, our_only_employee_count,
       match_count, within_tolerance_count, difference_count, one_sided_count,
       prior_gross, our_gross, prior_net, our_net,
       prior_employer_cost, our_employer_cost,
       unattributed_gross, unattributed_net, unattributed_employer_cost,
       tolerances_applied, unmapped_columns, blocked_reason, created_by, updated_by)
    values (${input.orgId}, ${input.registerId}, ${input.payRunDocumentId}, ${comparison.status},
            ${comparison.populations.prior}, ${comparison.populations.ours},
            ${comparison.populations.compared}, ${comparison.populations.priorOnly},
            ${comparison.populations.ourOnly},
            ${comparison.counts.match}, ${comparison.counts.within_tolerance},
            ${comparison.counts.difference},
            ${comparison.counts.prior_only + comparison.counts.our_only +
              comparison.counts.employee_prior_only + comparison.counts.employee_our_only},
            ${comparison.totals.gross.prior}, ${comparison.totals.gross.ours},
            ${comparison.totals.netPay.prior}, ${comparison.totals.netPay.ours},
            ${comparison.totals.employerCost.prior}, ${comparison.totals.employerCost.ours},
            ${comparison.totals.gross.unattributed}, ${comparison.totals.netPay.unattributed},
            ${comparison.totals.employerCost.unattributed},
            ${JSON.stringify(comparison.tolerancesApplied)}::jsonb,
            ${JSON.stringify(comparison.unmappedColumns)}::jsonb,
            ${comparison.blockedReason}, ${input.actorId}, ${input.actorId})
    returning id`));
  const comparisonId = header.rows[0]!.id;

  // Findings in one multi-row insert. A per-row loop over a 400-employee
  // register is 4,000 round trips.
  const values = comparison.findings.map(
    (finding) => sql`(
      ${input.orgId}, ${comparisonId}, ${finding.employeePartyId}, ${finding.employeeName},
      ${finding.kind}, ${finding.slot}, ${finding.slotLabel}, ${finding.classification},
      ${finding.priorAmount}, ${finding.ourAmount}, ${finding.difference},
      ${finding.toleranceApplied}, ${finding.sourceColumn}, ${finding.sequence},
      ${input.actorId}, ${input.actorId})`,
  );
  for (let index = 0; index < values.length; index += 500) {
    const chunk = values.slice(index, index + 500);
    await db.execute(sql`
      insert into payroll_parallel_findings
        (org_id, comparison_id, employee_party_id, employee_name, kind, slot, slot_label,
         classification, prior_amount, our_amount, difference, tolerance_applied,
         source_column, sequence, created_by, updated_by)
      values ${sql.join(chunk, sql`, `)}`);
  }

  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'payroll_parallel_comparisons', ${comparisonId}, 'insert',
            ${JSON.stringify({
              registerId: input.registerId,
              payRunDocumentId: input.payRunDocumentId,
              status: comparison.status,
              compared: comparison.populations.compared,
              differences: comparison.counts.difference,
              tolerances: comparison.tolerancesApplied.length,
            })}, ${input.actorId})`);

  return { comparisonId, comparison };
}

export interface ComparisonSummary {
  id: string;
  registerId: string;
  registerName: string;
  payRunDocumentId: string;
  payRunNumber: string;
  status: string;
  blockedReason: string | null;
  comparedAt: string;
  priorEmployeeCount: number;
  ourEmployeeCount: number;
  comparedEmployeeCount: number;
  matchCount: number;
  withinToleranceCount: number;
  differenceCount: number;
  oneSidedCount: number;
  priorGross: string;
  ourGross: string;
  priorNet: string;
  ourNet: string;
  /** prior − ours, computed here so no caller subtracts money in JavaScript. */
  grossDifference: string;
  netDifference: string;
  unattributedNet: string;
  tolerancesApplied: ParallelTolerance[];
  unmappedColumns: UnmappedSourceColumn[];
}

/** Filed comparisons, newest first. */
export async function parallelComparisons(
  orgId: string,
  opts: { registerId?: string; payRunDocumentId?: string; limit?: number } = {},
): Promise<ComparisonSummary[]> {
  const filters = [sql`c.org_id = ${orgId}`];
  if (opts.registerId) filters.push(sql`c.register_id = ${opts.registerId}`);
  if (opts.payRunDocumentId) filters.push(sql`c.pay_run_document_id = ${opts.payRunDocumentId}`);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const rows = (await db.execute<Record<string, unknown>>(sql`
    select c.*, r.name as register_name,
           coalesce(d.document_number, c.pay_run_document_id::text) as pay_run_number,
           c.compared_at::text as compared_at_text
      from payroll_parallel_comparisons c
      join payroll_prior_registers r on r.id = c.register_id and r.org_id = c.org_id
      left join documents d on d.id = c.pay_run_document_id and d.org_id = c.org_id
     where ${sql.join(filters, sql` and `)}
     order by c.compared_at desc
     limit ${limit}`));

  return rows.rows.map((row) => ({
    id: String(row.id),
    registerId: String(row.register_id),
    registerName: String(row.register_name),
    payRunDocumentId: String(row.pay_run_document_id),
    payRunNumber: String(row.pay_run_number),
    status: String(row.status),
    blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
    comparedAt: String(row.compared_at_text),
    priorEmployeeCount: asCount(row.prior_employee_count),
    ourEmployeeCount: asCount(row.our_employee_count),
    comparedEmployeeCount: asCount(row.compared_employee_count),
    matchCount: asCount(row.match_count),
    withinToleranceCount: asCount(row.within_tolerance_count),
    differenceCount: asCount(row.difference_count),
    oneSidedCount: asCount(row.one_sided_count),
    priorGross: normalizeMoney(String(row.prior_gross ?? "0")),
    ourGross: normalizeMoney(String(row.our_gross ?? "0")),
    priorNet: normalizeMoney(String(row.prior_net ?? "0")),
    ourNet: normalizeMoney(String(row.our_net ?? "0")),
    grossDifference: difference(
      String(row.prior_gross ?? "0"),
      String(row.our_gross ?? "0"),
    ),
    netDifference: difference(String(row.prior_net ?? "0"), String(row.our_net ?? "0")),
    unattributedNet: normalizeMoney(String(row.unattributed_net ?? "0")),
    tolerancesApplied: parseTolerances(row.tolerances_applied),
    unmappedColumns: parseUnmapped(row.unmapped_columns),
  }));
}

function parseTolerances(raw: unknown): ParallelTolerance[] {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = entry as Partial<ParallelTolerance>;
    return {
      kind: (row.kind ?? "total") as ParallelFindingKind,
      slot: String(row.slot ?? ""),
      tolerance: normalizeMoney(String(row.tolerance ?? EXACT)),
      reason: String(row.reason ?? ""),
    };
  });
}

export interface StoredFinding {
  id: string;
  employeePartyId: string | null;
  employeeName: string;
  kind: string;
  slot: string;
  slotLabel: string;
  classification: string;
  priorAmount: string | null;
  ourAmount: string | null;
  difference: string | null;
  toleranceApplied: string;
  sourceColumn: string | null;
}

/** One comparison's stored findings, optionally narrowed to one employee. */
export async function comparisonFindings(
  orgId: string,
  comparisonId: string,
  opts: { employeePartyId?: string; classifications?: string[] } = {},
): Promise<StoredFinding[]> {
  const filters = [sql`f.org_id = ${orgId}`, sql`f.comparison_id = ${comparisonId}`];
  if (opts.employeePartyId) filters.push(sql`f.employee_party_id = ${opts.employeePartyId}`);
  if (opts.classifications?.length) {
    filters.push(
      sql`f.classification in (${sql.join(
        opts.classifications.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    );
  }
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select f.id, f.employee_party_id, f.employee_name, f.kind, f.slot, f.slot_label,
           f.classification, f.prior_amount, f.our_amount, f.difference,
           f.tolerance_applied, f.source_column
      from payroll_parallel_findings f
     where ${sql.join(filters, sql` and `)}
     order by f.employee_name, f.sequence, f.slot
     limit ${MAX_REGISTER_ROWS}`));

  return rows.rows.map((row) => ({
    id: String(row.id),
    employeePartyId: row.employee_party_id == null ? null : String(row.employee_party_id),
    employeeName: String(row.employee_name),
    kind: String(row.kind),
    slot: String(row.slot),
    slotLabel: String(row.slot_label),
    classification: String(row.classification),
    priorAmount: row.prior_amount == null ? null : normalizeMoney(String(row.prior_amount)),
    ourAmount: row.our_amount == null ? null : normalizeMoney(String(row.our_amount)),
    difference: row.difference == null ? null : normalizeMoney(String(row.difference)),
    toleranceApplied: normalizeMoney(String(row.tolerance_applied ?? EXACT)),
    sourceColumn: row.source_column == null ? null : String(row.source_column),
  }));
}

/** Calculated or committed runs a register could be compared against. */
export async function comparablePayRuns(
  orgId: string,
): Promise<{ documentId: string; label: string; periodStart: string; periodEnd: string; payDate: string; runStatus: string; employeeCount: number }[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select r.document_id, coalesce(d.document_number, r.document_id::text) as label,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.run_status, r.employee_count
      from pay_runs r
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.run_status in ('calculated', 'committed')
     order by r.pay_date desc
     limit 200`));
  return rows.rows.map((row) => ({
    documentId: String(row.document_id),
    label: String(row.label),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    payDate: String(row.pay_date),
    runStatus: String(row.run_status),
    employeeCount: asCount(row.employee_count),
  }));
}

/**
 * The pay run whose period a register lines up with, if exactly one does.
 *
 * A suggestion only — the operator always confirms which two sides to compare.
 * Guessing silently is how a register gets reconciled against the wrong period
 * and reported as a pile of differences nobody can explain.
 */
export async function suggestedPayRunForRegister(
  orgId: string,
  registerId: string,
): Promise<string | null> {
  const rows = (await db.execute<{ document_id: string }>(sql`
    select r.document_id
      from payroll_prior_registers g
      join pay_runs r on r.org_id = g.org_id
       and r.pay_date = g.pay_date
       and r.run_status in ('calculated', 'committed')
     where g.org_id = ${orgId} and g.id = ${registerId}
     limit 2`));
  return rows.rows.length === 1 ? rows.rows[0]!.document_id : null;
}

/** Slot vocabulary keys, for callers validating an import mapping. */
export function totalSlotForFieldKey(fieldKey: string): string | null {
  return TOTAL_FIELD_KEYS[fieldKey] ?? null;
}

export { TOTAL_SLOTS };
