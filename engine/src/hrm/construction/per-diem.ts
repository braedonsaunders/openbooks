import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import { requireHrmConstructionManage, requireHrmConstructionRead } from "../authorization.ts";
import {
  applyWeeklyRule,
  compareDecimal,
  perDiemAmountForDay,
  type DistanceBracket,
  type PerDiemBasis,
} from "./pure.ts";
import {
  HRM_PER_DIEM_FEATURE,
  assertConstructionFeature,
  requireDate,
  requireId,
  requireText,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Per-diem and travel pay (HR-13, migration 0223). computeForWeek reads
 * APPROVED time entries, prices each day from the applicable policy
 * (brackets, lodging offset, weekly rule), and writes entries; approval
 * crosses amounts into the hrm_allowance_payroll_inputs seam the payroll
 * coordinator's consumer reads like the benefits seam. Travel reuses the
 * same policy table with its own basis reading (hourly | per_km |
 * bracketed) into a SEPARATE entries table so voids never cross.
 *
 * Distance comes from the org's declared home base to the project
 * location: the policy rules name a home location (or coordinates) and
 * the project's custom names its location; coordinates ride the
 * locations custom, never a new column. A distance policy without
 * coordinates on both ends refuses BY NAME — never zero kilometres.
 */

export interface PerDiemPolicy {
  readonly id: string;
  readonly name: string;
  readonly basis: PerDiemBasis;
  readonly rules: Record<string, unknown>;
  readonly lodgingOffset: string | null;
  readonly weeklyRule: { worked_days: number; paid_days: number } | null;
  readonly payComponentId: string | null;
  readonly currency: string;
}

export interface PerDiemEntry {
  readonly id: string;
  readonly employmentId: string;
  readonly projectId: string | null;
  readonly workedOn: string;
  readonly policyId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
}

export async function listPolicies(exec: SqlExecutor, orgId: string, actorId: string): Promise<readonly PerDiemPolicy[]> {
  await assertConstructionFeature(exec, orgId, HRM_PER_DIEM_FEATURE, "Per-diem policies");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const rows = (
    await exec.execute<{
      id: string;
      name: string;
      basis: PerDiemBasis;
      rules: Record<string, unknown>;
      lodgingOffset: string | null;
      weeklyRule: { worked_days: number; paid_days: number } | null;
      payComponentId: string | null;
      currency: string;
    }>(sql`
      select id::text as id, name, basis, rules,
             lodging_offset::text as "lodgingOffset", weekly_rule as "weeklyRule",
             pay_component_id::text as "payComponentId", currency
        from hrm_per_diem_policies
       where org_id = ${orgId}::uuid
       order by name
    `)
  ).rows;
  return rows;
}

export async function createPolicy(
  exec: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    name: string;
    basis: PerDiemBasis;
    rules: Record<string, unknown>;
    lodgingOffset?: string | null;
    weeklyRule?: { worked_days: number; paid_days: number } | null;
    payComponentId?: string | null;
    currency: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
): Promise<PerDiemPolicy> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  await assertConstructionFeature(exec, orgId, HRM_PER_DIEM_FEATURE, "Per-diem policies");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const name = requireText(input.name, "name");
  if (!["flat_daily", "distance_brackets", "hours_threshold"].includes(input.basis)) {
    throw new HrmConstructionError(
      `Unknown per-diem basis ${input.basis} — use flat_daily, distance_brackets, or hours_threshold.`,
    );
  }
  assertRulesForBasis(input.basis, input.rules ?? {});
  const weeklyRule = input.weeklyRule ?? null;
  if (weeklyRule) {
    if (!Number.isInteger(weeklyRule.worked_days) || !Number.isInteger(weeklyRule.paid_days) || weeklyRule.worked_days < 1 || weeklyRule.paid_days < weeklyRule.worked_days) {
      throw new HrmConstructionError(
        "The weekly rule needs worked_days of at least 1 and paid_days at least worked_days — e.g. 5 worked days paid as 7.",
      );
    }
  }
  const currency = requireText(input.currency, "currency");
  if (currency.length !== 3) throw new HrmConstructionError("Currency must be a 3-letter ISO code.");
  const effectiveFrom = requireDate(input.effectiveFrom, "effectiveFrom");
  if (input.payComponentId) {
    await assertAllowanceComponent(exec, orgId, input.payComponentId);
  }
  const created = (
    await exec.execute<{ id: string }>(sql`
      insert into hrm_per_diem_policies
        (org_id, name, basis, rules, lodging_offset, weekly_rule,
         pay_component_id, currency, effective_from, effective_to, created_by, updated_by)
      values (${orgId}::uuid, ${name}, ${input.basis}, ${JSON.stringify(input.rules ?? {})}::jsonb,
              ${input.lodgingOffset ?? null}, ${weeklyRule ? JSON.stringify(weeklyRule) : null}::jsonb,
              ${input.payComponentId ?? null}::uuid,
              ${currency.toUpperCase()}, ${effectiveFrom}::date, ${input.effectiveTo ?? null}::date,
              ${input.actorId}::uuid, ${input.actorId}::uuid)
      returning id::text as id
    `)
  ).rows[0];
  if (!created) throw new HrmConstructionError(`Per-diem policy ${name} was not created — no row was written.`);
  const rows = await listPolicies(exec, orgId, input.actorId);
  const found = rows.find((row) => row.id === created.id);
  if (!found) throw new HrmConstructionError(`Per-diem policy ${name} was not created — it cannot be read back.`);
  return found;
}

/** The zod-equivalent shape pin per basis: rules carry what the basis reads, nothing else. */
export function assertRulesForBasis(basis: PerDiemBasis, rules: Record<string, unknown>): void {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    throw new HrmConstructionError("Policy rules must be a JSON object.");
  }
  if (basis === "flat_daily") {
    if (typeof rules.amount !== "string" || !/^\d+(\.\d{1,4})?$/.test(rules.amount)) {
      throw new HrmConstructionError("A flat-daily policy needs rules.amount as a non-negative decimal string.");
    }
    return;
  }
  if (basis === "distance_brackets") {
    if (!Array.isArray(rules.brackets) || rules.brackets.length === 0) {
      throw new HrmConstructionError("A distance-bracket policy needs rules.brackets with at least one bracket.");
    }
    for (const bracket of rules.brackets as readonly Record<string, unknown>[]) {
      if (typeof bracket.min_km !== "number" || (bracket.max_km !== null && typeof bracket.max_km !== "number")) {
        throw new HrmConstructionError("Every distance bracket needs min_km and max_km (null for open-ended) as numbers.");
      }
      if (typeof bracket.amount !== "string" || !/^\d+(\.\d{1,4})?$/.test(bracket.amount)) {
        throw new HrmConstructionError("Every distance bracket needs amount as a non-negative decimal string.");
      }
    }
    return;
  }
  if (typeof rules.min_hours !== "number" || typeof rules.amount_for_hours !== "string") {
    throw new HrmConstructionError("An hours-threshold policy needs rules.min_hours (number) and rules.amount_for_hours (decimal string).");
  }
  if (typeof rules.amount_per_km !== "undefined" && typeof rules.amount_per_km !== "string") {
    throw new HrmConstructionError("rules.amount_per_km, when present for travel per-km reading, must be a decimal string.");
  }
}

/**
 * The linked pay component must be kind 'earning' PER THE COMPONENT'S
 * OWN DECLARATION: per-diem and travel are amounts paid TO the worker,
 * so the run prices them as earnings — taxability rides the component's
 * tax_treatment, never a second flag here. Validated at generation from
 * the component's own row and never stored on the seam row (the run
 * prices from the component, like the benefits seam).
 */
/** The only component kind per-diem and travel cross through (see above). */
const ALLOWANCE_COMPONENT_KIND = "earning";
export async function assertAllowanceComponent(
  exec: SqlExecutor,
  orgId: string,
  payComponentId: string,
): Promise<{ kind: string; taxTreatment: string }> {
  const row = (
    await exec.execute<{ kind: string; taxTreatment: string }>(sql`
      select kind, tax_treatment as "taxTreatment"
        from pay_components where org_id = ${orgId}::uuid and id = ${payComponentId}::uuid
    `)
  ).rows[0];
  if (!row) {
    throw new HrmConstructionError(
      `Pay component ${payComponentId} does not exist in this organization — link the policy to an allowance or reimbursement component.`,
    );
  }
  if (row.kind !== ALLOWANCE_COMPONENT_KIND) {
    throw new HrmConstructionError(
      `Pay component ${payComponentId} is kind ${row.kind} — per-diem and travel are paid to the worker, so they cross to payroll only through earning components (taxability rides the component's tax_treatment).`,
    );
  }
  return row;
}

/** Approved time for one employment across a Monday-start week, grouped by day and project. */
async function approvedWeekHours(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
  weekStart: string,
): Promise<ReadonlyArray<{ workedOn: string; projectId: string | null; hours: string }>> {
  const rows = (
    await exec.execute<{ workedOn: string; projectId: string | null; hours: string }>(sql`
      select worked_on::text as "workedOn", project_id::text as "projectId",
             sum(hours)::text as hours
        from time_entries
       where org_id = ${orgId}::uuid and employee_party_id = ${partyId}::uuid
         and status = 'approved'
         and worked_on >= ${weekStart}::date and worked_on < (${weekStart}::date + interval '7 days')
       group by worked_on, project_id
       order by worked_on
    `)
  ).rows;
  return rows;
}

function weekDates(weekStart: string): readonly string[] {
  const [y, m, d] = weekStart.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, d!));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start.getTime() + i * 86_400_000);
    return day.toISOString().slice(0, 10);
  });
}

async function coordinatesForLocation(
  exec: SqlExecutor,
  orgId: string,
  locationId: string,
): Promise<{ lat: number; lng: number } | null> {
  const row = (
    await exec.execute<{ custom: Record<string, unknown> }>(sql`
      select custom from locations where org_id = ${orgId}::uuid and id = ${locationId}::uuid
    `)
  ).rows[0];
  const custom = row?.custom;
  if (!custom) return null;
  const lat = Number(custom.latitude ?? custom.lat);
  const lng = Number(custom.longitude ?? custom.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function projectLocationId(
  exec: SqlExecutor,
  orgId: string,
  projectId: string,
): Promise<string | null> {
  const row = (
    await exec.execute<{ custom: Record<string, unknown> }>(sql`
      select custom from projects where org_id = ${orgId}::uuid and id = ${projectId}::uuid
    `)
  ).rows[0];
  const locationId = row?.custom?.location_id;
  return typeof locationId === "string" ? locationId : null;
}

/** Great-circle kilometres — the distance a bracket policy prices. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function subtractDecimal(a: string, b: string): string {
  const scale = (v: string): bigint => {
    const [i, f = ""] = v.split(".");
    return BigInt(`${i}${(f + "0000").slice(0, 4)}`);
  };
  const diff = scale(a) - scale(b);
  const negative = diff < 0n ? "-" : "";
  const abs = (diff < 0n ? -diff : diff).toString().padStart(5, "0");
  const whole = abs.slice(0, -4);
  const frac = abs.slice(-4);
  return `${negative}${whole}.${frac}`;
}

async function employmentParty(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<string> {
  const row = (
    await exec.execute<{ partyId: string }>(sql`
      select worker_party_id::text as "partyId"
        from worker_employments where org_id = ${orgId}::uuid and id = ${employmentId}::uuid
    `)
  ).rows[0];
  if (!row) {
    throw new HrmConstructionError(
      `Employment ${employmentId} does not exist in this organization — compute per-diem for one of its employments.`,
    );
  }
  return row.partyId;
}

async function policyForWeek(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  weekStart: string,
): Promise<PerDiemPolicy> {
  const policies = await listPolicies(exec, orgId, actorId);
  const covering = policies.filter((policy) => policy.currency);
  if (covering.length === 0) {
    throw new HrmConstructionError(
      `No per-diem policy exists in this organization — declare one before computing the week of ${weekStart}.`,
    );
  }
  // Deterministic: first by name among policies whose window covers the week.
  const rows = (
    await exec.execute<{ id: string }>(sql`
      select id::text as id from hrm_per_diem_policies
       where org_id = ${orgId}::uuid and is_active
         and effective_from <= ${weekStart}::date
         and (effective_to is null or effective_to >= ${weekStart}::date)
       order by name limit 1
    `)
  ).rows[0];
  if (!rows) {
    throw new HrmConstructionError(
      `No per-diem policy covers the week of ${weekStart} — declare or extend one before computing.`,
    );
  }
  const found = covering.find((policy) => policy.id === rows.id);
  if (!found) throw new HrmConstructionError("The covering per-diem policy cannot be read back.");
  return found;
}

/**
 * Compute one employment's per-diem week. Writes computed entries (one
 * per employment per project per day); existing computed rows regenerate,
 * approved/consumed/voided rows refuse — history is voided, never
 * rewritten. The weekly rule tops up short weeks on the week's own
 * unworked days at the last daily amount.
 */
export async function computeForWeek(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; employmentId: string; weekStart: string },
): Promise<readonly PerDiemEntry[]> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  const employmentId = requireId(input.employmentId, "employmentId");
  const weekStart = requireDate(input.weekStart, "weekStart");
  await assertConstructionFeature(exec, orgId, HRM_PER_DIEM_FEATURE, "Per-diem computation");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const partyId = await employmentParty(exec, orgId, employmentId);
  const policy = await policyForWeek(exec, orgId, input.actorId, weekStart);
  const days = await approvedWeekHours(exec, orgId, partyId, weekStart);
  if (days.length === 0) {
    throw new HrmConstructionError(
      `Employment ${employmentId} has no approved time in the week of ${weekStart} — approve the timesheet before computing per-diem.`,
    );
  }
  const rules = policy.rules as {
    amount?: string;
    brackets?: readonly DistanceBracket[];
    min_hours?: number;
    amount_for_hours?: string;
    home_location_id?: string;
    home_lat?: number;
    home_lng?: number;
  };
  let home: { lat: number; lng: number } | null = null;
  if (typeof rules.home_location_id === "string") {
    home = await coordinatesForLocation(exec, orgId, rules.home_location_id);
  } else if (typeof rules.home_lat === "number" && typeof rules.home_lng === "number") {
    home = { lat: rules.home_lat, lng: rules.home_lng };
  }
  const written: PerDiemEntry[] = [];
  const dailyAmounts: string[] = [];
  for (const day of days) {
    let distanceKm: number | null = null;
    if (policy.basis === "distance_brackets") {
      if (!home) {
        throw new HrmConstructionError(
          `Per-diem policy ${policy.name} is distance-based but declares no home base — set rules.home_location_id or home coordinates before computing.`,
        );
      }
      if (!day.projectId) {
        throw new HrmConstructionError(
          `Approved time on ${day.workedOn} names no project — distance per-diem prices project days only.`,
        );
      }
      const locationId = await projectLocationId(exec, orgId, day.projectId);
      if (!locationId) {
        throw new HrmConstructionError(
          `Project ${day.projectId} declares no location — set custom.location_id on the project before computing distance per-diem.`,
        );
      }
      const coords = await coordinatesForLocation(exec, orgId, locationId);
      if (!coords) {
        throw new HrmConstructionError(
          `Location ${locationId} carries no coordinates — set latitude/longitude on the location before computing distance per-diem.`,
        );
      }
      distanceKm = haversineKm(home, coords);
    }
    let amount = perDiemAmountForDay(
      policy.basis,
      {
        amount: rules.amount,
        brackets: rules.brackets,
        min_hours: rules.min_hours,
        amount_for_hours: rules.amount_for_hours,
      },
      { distanceKm, hours: day.hours },
    );
    if (policy.lodgingOffset && compareDecimal(policy.lodgingOffset, "0") > 0 && compareDecimal(amount, "0") > 0) {
      const reduced = subtractDecimal(amount, policy.lodgingOffset);
      amount = compareDecimal(reduced, "0") > 0 ? reduced : "0.0000";
    }
    dailyAmounts.push(amount);
    written.push(
      await upsertEntry(exec, orgId, input.actorId, "hrm_per_diem_entries", {
        employmentId,
        projectId: day.projectId,
        workedOn: day.workedOn,
        policyId: policy.id,
        amount,
        currency: policy.currency,
        basisInputs: { distance_km: distanceKm, hours: day.hours },
      }),
    );
  }
  // Weekly top-up: 5 worked days paid as 7 writes the two missing days of
  // the same week at the last daily amount — same table, same policy, the
  // basis_inputs say what produced them.
  const topped = applyWeeklyRule(dailyAmounts, policy.weeklyRule);
  if (topped.length > dailyAmounts.length) {
    const existingDays = new Set(days.map((day) => day.workedOn));
    const missing = weekDates(weekStart).filter((date) => !existingDays.has(date));
    const lastProject = days[days.length - 1]!.projectId;
    for (let i = dailyAmounts.length; i < topped.length; i += 1) {
      const date = missing[i - dailyAmounts.length];
      if (!date) break;
      written.push(
        await upsertEntry(exec, orgId, input.actorId, "hrm_per_diem_entries", {
          employmentId,
          projectId: lastProject,
          workedOn: date,
          policyId: policy.id,
          amount: topped[i]!,
          currency: policy.currency,
          basisInputs: { weekly_rule_top_up: true },
        }),
      );
    }
  }
  return written;
}

async function upsertEntry(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  table: "hrm_per_diem_entries" | "hrm_travel_pay_entries",
  entry: {
    employmentId: string;
    projectId: string | null;
    workedOn: string;
    policyId: string;
    amount: string;
    currency: string;
    basisInputs: Record<string, unknown>;
  },
): Promise<PerDiemEntry> {
  const existing = (
    await exec.execute<{ id: string; status: string }>(sql`
      select id::text as id, status from ${sql.raw(table)}
       where org_id = ${orgId}::uuid and employment_id = ${entry.employmentId}::uuid
         and project_id is not distinct from ${entry.projectId}::uuid
         and worked_on = ${entry.workedOn}::date
    `)
  ).rows[0];
  if (existing && existing.status !== "computed") {
    throw new HrmConstructionError(
      `The ${entry.workedOn} entry is ${existing.status} — void it with a reason before recomputing the day.`,
    );
  }
  if (existing) {
    await exec.execute(sql`
      update ${sql.raw(table)}
         set policy_id = ${entry.policyId}::uuid, amount = ${entry.amount},
             currency = ${entry.currency}, basis_inputs = ${JSON.stringify(entry.basisInputs)}::jsonb,
             updated_by = ${actorId}::uuid, updated_at = now()
       where id = ${existing.id}::uuid
    `);
    return readEntry(exec, orgId, table, String(existing.id));
  }
  const created = (
    await exec.execute<{ id: string }>(sql`
      insert into ${sql.raw(table)}
        (org_id, employment_id, project_id, worked_on, policy_id, amount, currency,
         basis_inputs, status, created_by, updated_by)
      values (${orgId}::uuid, ${entry.employmentId}::uuid, ${entry.projectId}::uuid,
              ${entry.workedOn}::date, ${entry.policyId}::uuid, ${entry.amount},
              ${entry.currency}, ${JSON.stringify(entry.basisInputs)}::jsonb, 'computed',
              ${actorId}::uuid, ${actorId}::uuid)
      returning id::text as id
    `)
  ).rows[0];
  if (!created) throw new HrmConstructionError(`The ${entry.workedOn} entry was not written — no row was created.`);
  return readEntry(exec, orgId, table, String(created.id));
}

async function readEntry(
  exec: SqlExecutor,
  orgId: string,
  table: "hrm_per_diem_entries" | "hrm_travel_pay_entries",
  id: string,
): Promise<PerDiemEntry> {
  const row = (
    await exec.execute<{
      id: string;
      employmentId: string;
      projectId: string | null;
      workedOn: string;
      policyId: string;
      amount: string;
      currency: string;
      status: string;
    }>(sql`
      select id::text as id, employment_id::text as "employmentId",
             project_id::text as "projectId", worked_on::text as "workedOn",
             policy_id::text as "policyId", amount::text as amount, currency, status
        from ${sql.raw(table)}
       where org_id = ${orgId}::uuid and id = ${id}::uuid
    `)
  ).rows[0];
  if (!row) throw new HrmConstructionError(`Entry ${id} cannot be read back.`);
  return row;
}

export async function listEntries(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  status?: string | null,
): Promise<readonly PerDiemEntry[]> {
  await assertConstructionFeature(exec, orgId, HRM_PER_DIEM_FEATURE, "Per-diem entries");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const rows = (
    await exec.execute<{
      id: string;
      employmentId: string;
      projectId: string | null;
      workedOn: string;
      policyId: string;
      amount: string;
      currency: string;
      status: string;
    }>(sql`
      select id::text as id, employment_id::text as "employmentId",
             project_id::text as "projectId", worked_on::text as "workedOn",
             policy_id::text as "policyId", amount::text as amount, currency, status
        from hrm_per_diem_entries
       where org_id = ${orgId}::uuid
         and (${status}::text is null or status = ${status}::text)
       order by worked_on desc
    `)
  ).rows;
  return rows;
}

/**
 * Approve an entry: the amount crosses into the allowance seam the
 * payroll consumer reads. The component's kind and tax treatment are
 * validated at generation from the component's own declaration — never
 * stored on the row.
 */
export async function approveEntry(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; entryId: string; kind: "per_diem" | "travel" },
): Promise<PerDiemEntry> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  const entryId = requireId(input.entryId, "entryId");
  await assertConstructionFeature(exec, orgId, HRM_PER_DIEM_FEATURE, "Per-diem approval");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const table = input.kind === "per_diem" ? "hrm_per_diem_entries" : "hrm_travel_pay_entries";
  const entry = (
    await exec.execute<{
      id: string;
      employmentId: string;
      partyId: string;
      policyId: string;
      componentId: string | null;
      amount: string;
      currency: string;
      workedOn: string;
      status: string;
    }>(sql`
      select e.id::text as id, e.employment_id::text as "employmentId",
             w.worker_party_id::text as "partyId",
             e.policy_id::text as "policyId", p.pay_component_id::text as "componentId",
             e.amount::text as amount, e.currency, e.worked_on::text as "workedOn", e.status
        from ${sql.raw(table)} e
        join worker_employments w on w.org_id = e.org_id and w.id = e.employment_id
        join hrm_per_diem_policies p on p.org_id = e.org_id and p.id = e.policy_id
       where e.org_id = ${orgId}::uuid and e.id = ${entryId}::uuid
    `)
  ).rows[0];
  if (!entry) {
    throw new HrmConstructionError(
      `Entry ${entryId} does not exist in this organization — approve one of its entries.`,
    );
  }
  if (entry.status !== "computed") {
    throw new HrmConstructionError(
      `Entry ${entryId} is ${entry.status} — only computed entries approve.`,
    );
  }
  if (!entry.componentId) {
    throw new HrmConstructionError(
      "The entry's policy names no pay component — link an allowance or reimbursement component before approving.",
    );
  }
  await assertAllowanceComponent(exec, orgId, entry.componentId);
  await exec.execute(sql`
    update ${sql.raw(table)}
       set status = 'approved', updated_by = ${input.actorId}::uuid, updated_at = now()
     where id = ${entryId}::uuid
  `);
  await exec.execute(sql`
    insert into hrm_allowance_payroll_inputs
      (org_id, entry_kind, entry_id, employment_id, employee_party_id, pay_component_id,
       amount, currency, coverage_date, status, created_by, updated_by)
    values (${orgId}::uuid, ${input.kind}, ${entryId}::uuid, ${entry.employmentId}::uuid,
            ${entry.partyId}::uuid, ${entry.componentId}::uuid,
            ${entry.amount}, ${entry.currency}, ${entry.workedOn}::date, 'pending',
            ${input.actorId}::uuid, ${input.actorId}::uuid)
    on conflict (org_id, entry_kind, entry_id) do nothing
  `);
  // on conflict do nothing is justified here: approval is idempotent —
  // the seam row is keyed by the entry, so a second approval of the same
  // entry carries the same amount and must not double-pay.
  return readEntry(exec, orgId, table, entryId);
}

/**
 * Void an entry with a reason: the entry and its seam row void together.
 * A consumed seam row refuses — recalculate the run instead of unlinking
 * it; the void guard below keeps the link in every other case.
 */
export async function voidEntry(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; entryId: string; kind: "per_diem" | "travel"; reason: string },
): Promise<PerDiemEntry> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  const entryId = requireId(input.entryId, "entryId");
  const reason = requireText(input.reason, "reason");
  await assertConstructionFeature(exec, orgId, HRM_PER_DIEM_FEATURE, "Per-diem voids");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const table = input.kind === "per_diem" ? "hrm_per_diem_entries" : "hrm_travel_pay_entries";
  const seam = (
    await exec.execute<{ status: string | null; runId: string | null }>(sql`
      select status, consumed_by_run_document_id::text as "runId"
        from hrm_allowance_payroll_inputs
       where org_id = ${orgId}::uuid and entry_kind = ${input.kind} and entry_id = ${entryId}::uuid
    `)
  ).rows[0];
  if (seam && seam.status === "consumed") {
    throw new HrmConstructionError(
      `Entry ${entryId} was consumed by pay run ${seam.runId} — recalculate the run instead of voiding it.`,
    );
  }
  const updated = (
    await exec.execute<{ id: string }>(sql`
      update ${sql.raw(table)}
         set status = 'voided', voided_at = now(), void_reason = ${reason},
             updated_by = ${input.actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${entryId}::uuid and status in ('computed', 'approved')
      returning id::text as id
    `)
  ).rows[0];
  if (!updated) {
    throw new HrmConstructionError(
      `Entry ${entryId} cannot be voided — it does not exist here or is already voided or consumed.`,
    );
  }
  if (seam) {
    await exec.execute(sql`
      update hrm_allowance_payroll_inputs
         set status = 'voided', voided_at = now(), void_reason = ${reason},
             updated_by = ${input.actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and entry_kind = ${input.kind} and entry_id = ${entryId}::uuid
    `);
  }
  return readEntry(exec, orgId, table, entryId);
}

/**
 * Travel pay for a week: hourly (amount_for_hours × approved hours),
 * per_km (amount_per_km × distance), or bracketed (same brackets as
 * per-diem). Separate entries table so voids never cross.
 */
export async function computeTravelForWeek(
  exec: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    employmentId: string;
    weekStart: string;
    mode: "hourly" | "per_km" | "bracketed";
  },
): Promise<readonly PerDiemEntry[]> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  const employmentId = requireId(input.employmentId, "employmentId");
  const weekStart = requireDate(input.weekStart, "weekStart");
  await assertConstructionFeature(exec, orgId, HRM_PER_DIEM_FEATURE, "Travel-pay computation");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const partyId = await employmentParty(exec, orgId, employmentId);
  const policy = await policyForWeek(exec, orgId, input.actorId, weekStart);
  const days = await approvedWeekHours(exec, orgId, partyId, weekStart);
  if (days.length === 0) {
    throw new HrmConstructionError(
      `Employment ${employmentId} has no approved time in the week of ${weekStart} — approve the timesheet before computing travel pay.`,
    );
  }
  const rules = policy.rules as {
    brackets?: readonly DistanceBracket[];
    amount_for_hours?: string;
    amount_per_km?: string;
    home_location_id?: string;
    home_lat?: number;
    home_lng?: number;
  };
  let home: { lat: number; lng: number } | null = null;
  if (typeof rules.home_location_id === "string") {
    home = await coordinatesForLocation(exec, orgId, rules.home_location_id);
  } else if (typeof rules.home_lat === "number" && typeof rules.home_lng === "number") {
    home = { lat: rules.home_lat, lng: rules.home_lng };
  }
  const written: PerDiemEntry[] = [];
  for (const day of days) {
    let amount: string;
    const basisInputs: Record<string, unknown> = { hours: day.hours, travel_mode: input.mode };
    if (input.mode === "hourly") {
      if (!rules.amount_for_hours) {
        throw new HrmConstructionError(
          `Policy ${policy.name} has no rules.amount_for_hours — set it before computing hourly travel pay.`,
        );
      }
      amount = multiplyDecimal(day.hours, rules.amount_for_hours);
    } else {
      if (!home) {
        throw new HrmConstructionError(
          `Policy ${policy.name} declares no home base — set rules.home_location_id or home coordinates before computing travel pay.`,
        );
      }
      if (!day.projectId) {
        throw new HrmConstructionError(
          `Approved time on ${day.workedOn} names no project — travel pay prices project days only.`,
        );
      }
      const locationId = await projectLocationId(exec, orgId, day.projectId);
      if (!locationId) {
        throw new HrmConstructionError(
          `Project ${day.projectId} declares no location — set custom.location_id on the project before computing travel pay.`,
        );
      }
      const coords = await coordinatesForLocation(exec, orgId, locationId);
      if (!coords) {
        throw new HrmConstructionError(
          `Location ${locationId} carries no coordinates — set latitude/longitude on the location before computing travel pay.`,
        );
      }
      const distanceKm = haversineKm(home, coords);
      basisInputs.distance_km = distanceKm;
      if (input.mode === "per_km") {
        if (!rules.amount_per_km) {
          throw new HrmConstructionError(
            `Policy ${policy.name} has no rules.amount_per_km — set it before computing per-km travel pay.`,
          );
        }
        amount = multiplyDecimal(distanceKm.toFixed(4), rules.amount_per_km);
      } else {
        amount = perDiemAmountForDay(
          "distance_brackets",
          { brackets: rules.brackets },
          { distanceKm },
        );
      }
    }
    written.push(
      await upsertEntry(exec, orgId, input.actorId, "hrm_travel_pay_entries", {
        employmentId,
        projectId: day.projectId,
        workedOn: day.workedOn,
        policyId: policy.id,
        amount,
        currency: policy.currency,
        basisInputs,
      }),
    );
  }
  return written;
}

function multiplyDecimal(a: string, b: string): string {
  const scale = (v: string): { negative: boolean; value: bigint } => {
    const negative = v.trim().startsWith("-");
    const [i, f = ""] = v.replace("-", "").split(".");
    return { negative, value: BigInt(`${i}${(f + "0000").slice(0, 4)}`) };
  };
  const left = scale(a);
  const right = scale(b);
  const product = (left.value * right.value) / 10_000n;
  const negative = left.negative !== right.negative && product !== 0n;
  const abs = (product < 0n ? -product : product).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${abs.slice(0, -4)}.${abs.slice(-4)}`;
}

/**
 * Seam reads for the payroll coordinator's consumer: pending rows to
 * consume, and the consumed marker the run sets after pricing.
 */
export async function listPendingSeam(
  exec: SqlExecutor,
  orgId: string,
): Promise<readonly { id: string; entryKind: string; amount: string; currency: string; coverageDate: string }[]> {
  const rows = (
    await exec.execute<{
      id: string;
      entryKind: string;
      amount: string;
      currency: string;
      coverageDate: string;
    }>(sql`
      select id::text as id, entry_kind as "entryKind", amount::text as amount,
             currency, coverage_date::text as "coverageDate"
        from hrm_allowance_payroll_inputs
       where org_id = ${orgId}::uuid and status = 'pending'
       order by coverage_date
    `)
  ).rows;
  return rows;
}

export async function markSeamConsumed(
  exec: SqlExecutor,
  orgId: string,
  seamId: string,
  runDocumentId: string,
): Promise<void> {
  const updated = (
    await exec.execute<{ id: string }>(sql`
      update hrm_allowance_payroll_inputs
         set status = 'consumed', consumed_by_run_document_id = ${runDocumentId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${seamId}::uuid and status = 'pending'
      returning id::text as id
    `)
  ).rows[0];
  if (!updated) {
    throw new HrmConstructionError(
      `Allowance seam row ${seamId} cannot be consumed — it does not exist here or is no longer pending.`,
    );
  }
}
