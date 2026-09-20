import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
export interface PayRunCalculationSourceSnapshot {
  version: 1;
  timeEntries: {
    id: string;
    employeePartyId: string;
    workedOn: string;
    hours: string;
    timeTypeId: string | null;
    projectId: string | null;
    departmentId: string | null;
    isBillable: boolean;
    createdAt: string;
    updatedAt: string;
    claimable: boolean;
  }[];
  timeTypes: {
    id: string;
    name: string;
    classification: string;
    costMultiplier: string;
    excludeFromWages: boolean;
    updatedAt: string;
  }[];
  payRates: {
    employeePartyId: string;
    payBasis: string;
    runCurrency: string | null;
    rateId: string | null;
    basis: string | null;
    rate: string | null;
    annualHours: string | null;
    currency: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    updatedAt: string | null;
    fx: {
      id: string;
      fromCurrency: string;
      toCurrency: string;
      asOf: string;
      rate: string;
      direction: "direct" | "inverse";
      resolvedRate: string;
      updatedAt: string;
    } | null;
  }[];
  /**
   * The payroll-costing account of every service item the run's locked time
   * entries point at. A routing input like time types and rates: it changes
   * the run's output (which account a cost lands in), so an edit after
   * Calculate must read stale — a misstated cost of sales is a wrong number
   * even when net pay is identical.
   */
  itemAccounts: {
    id: string;
    payrollExpenseAccountId: string | null;
    updatedAt: string;
  }[];
  claimEntryIds: string[];
}

type CalculationSourceRow = {
  run_exists: boolean;
  time_entries: PayRunCalculationSourceSnapshot["timeEntries"];
  time_types: PayRunCalculationSourceSnapshot["timeTypes"];
  pay_rates: PayRunCalculationSourceSnapshot["payRates"];
  item_accounts: PayRunCalculationSourceSnapshot["itemAccounts"];
  claim_entry_ids: string[];
};

/** Stable JSON independent of jsonb's object-key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function payRunCalculationSourceDigest(
  snapshot: PayRunCalculationSourceSnapshot,
): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function parsePayRunCalculationSource(
  value: unknown,
): PayRunCalculationSourceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<PayRunCalculationSourceSnapshot>;
  if (snapshot.version !== 1
      || !Array.isArray(snapshot.timeEntries)
      || !Array.isArray(snapshot.timeTypes)
      || !Array.isArray(snapshot.payRates)
      || !Array.isArray(snapshot.claimEntryIds)) return null;
  // Snapshots stored before item routing existed carry no itemAccounts; they
  // read as "no mapped items", so the first post-upgrade commit compares
  // honestly and refuses with the items reason instead of a bare selection.
  return {
    ...snapshot,
    itemAccounts: Array.isArray(snapshot.itemAccounts) ? snapshot.itemAccounts : [],
  } as PayRunCalculationSourceSnapshot;
}

/**
 * Re-derive the exact calculation population. The locked form is the commit
 * fence: every existing source row is held through the exact-ID claim and the
 * terminal transition. A new row that becomes visible after this statement's
 * PostgreSQL snapshot is later than the fence and is never claimed by this
 * run; every row visible at the fence must match the stored calculation.
 *
 * The three source CTEs deliberately share ONE SQL statement so their reads
 * cannot be torn across READ COMMITTED snapshots. Calculation runs under
 * REPEATABLE READ as an additional guarantee that these final evidence rows
 * are the same versions its earlier per-stub reads consumed.
 */
export async function payRunCalculationSource(
  orgId: string,
  documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  lockSources = false,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayRunCalculationSourceSnapshot | null> {
  const rowLock = lockSources ? sql`for update` : sql``;
  const entryRowLock = lockSources ? sql`for update of te` : sql``;
  const result = (await executor.execute<CalculationSourceRow>(sql`
    with run_scope as materialized (
      select r.org_id, r.document_id, r.period_start, r.period_end, r.run_type,
             d.currency as run_currency, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    stub_employees as materialized (
      select s.employee_party_id, prof.pay_basis, r.period_end, r.run_currency
        from run_scope r
        join pay_stubs s
          on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
        left join parties p
          on p.id = s.employee_party_id and p.org_id = s.org_id
        join employee_payroll_profiles prof
          on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
       where true ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    locked_entries as materialized (
      select te.id, te.employee_party_id, te.worked_on, te.hours, te.time_type_id,
             te.project_id, te.department_id, te.item_id, te.is_billable,
             te.created_at, te.updated_at,
             exists (
               select 1
                 from pay_stub_lines line
                 join pay_stubs stub
                   on stub.id = line.stub_id and stub.org_id = line.org_id
                 join pay_components component
                   on component.id = line.component_id and component.org_id = line.org_id
                where stub.org_id = r.org_id
                  and stub.pay_run_document_id = r.document_id
                  and stub.employee_party_id = te.employee_party_id
                  and component.system_key in ('base_pay', 'overtime')
                  and line.hours is not null
                  and line.time_type_id is not distinct from te.time_type_id
                  and line.project_id is not distinct from te.project_id
                  and line.department_id is not distinct from te.department_id
                  and line.item_id is not distinct from te.item_id
             ) as claimable
        from run_scope r
        join stub_employees employee on true
        join time_entries te
          on te.org_id = r.org_id and te.employee_party_id = employee.employee_party_id
         and te.status = 'approved'
         and te.worked_on between r.period_start and r.period_end
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = r.document_id::text)
       where r.run_type not in ('bonus', 'retro')
       order by te.id
       ${entryRowLock}
    ),
    locked_time_types as materialized (
      select tt.id, tt.name, tt.classification, tt.cost_multiplier,
             tt.exclude_from_wages, tt.updated_at
        from time_types tt
       where tt.org_id = ${orgId}
         and exists (
           select 1 from locked_entries entry where entry.time_type_id = tt.id
         )
       order by tt.id
       ${rowLock}
    ),
    locked_items as materialized (
      select i.id, i.payroll_expense_account_id, i.updated_at
        from items i
       where i.org_id = ${orgId}
         and exists (
           select 1 from locked_entries entry where entry.item_id = i.id
         )
       order by i.id
       ${rowLock}
    ),
    locked_rates as materialized (
      select employee.employee_party_id, employee.pay_basis,
             employee.run_currency,
             wage.id as rate_id, wage.basis, wage.rate, wage.annual_hours,
             wage.currency, wage.effective_from, wage.effective_to, wage.updated_at
        from stub_employees employee
        left join lateral (
          select w.id, w.basis, w.rate, w.annual_hours, w.currency,
                 w.effective_from, w.effective_to, w.updated_at
            from labor_cost_rates w
           where w.org_id = ${orgId}
             and w.employee_party_id = employee.employee_party_id
             and w.is_active and w.effective_from <= employee.period_end
             and (w.effective_to is null or w.effective_to >= employee.period_end)
           order by w.effective_from desc
           limit 1
           ${rowLock}
        ) wage on true
       order by employee.employee_party_id
    ),
    locked_fx as materialized (
      select rate.employee_party_id,
             fx.id, fx.from_currency, fx.to_currency, fx.as_of, fx.rate,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then 'direct' else 'inverse' end as direction,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then fx.rate
                  else (1 / fx.rate)::numeric(19,10) end as resolved_rate,
             fx.updated_at
        from locked_rates rate
        left join lateral (
          select candidate.id, candidate.from_currency, candidate.to_currency,
                 candidate.as_of, candidate.rate, candidate.updated_at
            from fx_rates candidate
           where candidate.org_id = ${orgId}
             and candidate.rate_type = 'spot'
             and candidate.as_of <= (select period_end from run_scope)
             and rate.currency is distinct from rate.run_currency
             and ((candidate.from_currency = rate.currency
                   and candidate.to_currency = rate.run_currency)
               or (candidate.from_currency = rate.run_currency
                   and candidate.to_currency = rate.currency))
           order by candidate.as_of desc,
                    case when candidate.from_currency = rate.currency
                              and candidate.to_currency = rate.run_currency
                         then 0 else 1 end
           limit 1
           ${rowLock}
        ) fx on true
    )
    select exists (select 1 from run_scope) as run_exists,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', entry.id::text,
               'employeePartyId', entry.employee_party_id::text,
               'workedOn', entry.worked_on::text,
               'hours', entry.hours::text,
               'timeTypeId', entry.time_type_id::text,
               'projectId', entry.project_id::text,
               'departmentId', entry.department_id::text,
               'isBillable', entry.is_billable,
               'createdAt', to_char(entry.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'updatedAt', to_char(entry.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'claimable', entry.claimable
             ) order by entry.id)
               from locked_entries entry
           ), '[]'::jsonb) as time_entries,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', tt.id::text,
               'name', tt.name,
               'classification', tt.classification,
               'costMultiplier', tt.cost_multiplier::text,
               'excludeFromWages', tt.exclude_from_wages,
               'updatedAt', to_char(tt.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) order by tt.id)
               from locked_time_types tt
           ), '[]'::jsonb) as time_types,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', item.id::text,
               'payrollExpenseAccountId', item.payroll_expense_account_id::text,
               'updatedAt', to_char(item.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) order by item.id)
               from locked_items item
           ), '[]'::jsonb) as item_accounts,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'employeePartyId', rate.employee_party_id::text,
               'payBasis', rate.pay_basis,
               'runCurrency', rate.run_currency,
               'rateId', rate.rate_id::text,
               'basis', rate.basis,
               'rate', rate.rate::text,
               'annualHours', rate.annual_hours::text,
               'currency', rate.currency,
               'effectiveFrom', rate.effective_from::text,
               'effectiveTo', rate.effective_to::text,
               'updatedAt', case when rate.updated_at is null then null else
                 to_char(rate.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
               'fx', case when fx.id is null then null else jsonb_build_object(
                 'id', fx.id::text,
                 'fromCurrency', fx.from_currency,
                 'toCurrency', fx.to_currency,
                 'asOf', fx.as_of::text,
                 'rate', fx.rate::text,
                 'direction', fx.direction,
                 'resolvedRate', fx.resolved_rate::text,
                 'updatedAt', to_char(fx.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               ) end
             ) order by rate.employee_party_id)
               from locked_rates rate
               left join locked_fx fx on fx.employee_party_id = rate.employee_party_id
           ), '[]'::jsonb) as pay_rates,
           coalesce((
             select jsonb_agg(to_jsonb(entry.id::text) order by entry.id)
               from locked_entries entry where entry.claimable
           ), '[]'::jsonb) as claim_entry_ids
  `));
  const row = result.rows[0];
  if (!row?.run_exists) return null;
  return {
    version: 1,
    timeEntries: row.time_entries ?? [],
    timeTypes: row.time_types ?? [],
    payRates: row.pay_rates ?? [],
    itemAccounts: row.item_accounts ?? [],
    claimEntryIds: row.claim_entry_ids ?? [],
  };
}

export function payRunCalculationSourceChanges(
  stored: PayRunCalculationSourceSnapshot,
  current: PayRunCalculationSourceSnapshot,
): { time: boolean; timeTypes: boolean; wages: boolean; items: boolean } {
  return {
    time: canonicalJson(stored.timeEntries) !== canonicalJson(current.timeEntries)
      || canonicalJson(stored.claimEntryIds) !== canonicalJson(current.claimEntryIds),
    timeTypes: canonicalJson(stored.timeTypes) !== canonicalJson(current.timeTypes),
    wages: canonicalJson(stored.payRates) !== canonicalJson(current.payRates),
    items: canonicalJson(stored.itemAccounts ?? []) !== canonicalJson(current.itemAccounts ?? []),
  };
}

/**
 * One employee's refused or warned calculation outcome.
 *
 * This is the persisted refusal record (migration 0182): calculate writes the
 * whole array wholesale on every pass, commit gates on the `refusal` entries,
 * and the run page renders them back. `employee` is the display name at
 * calculate time — narrative, not identity; the gate and the acknowledgement
 * bind to `employeePartyId`. `message` is the pack's (or engine's) own
 * refusal/warning text, carried verbatim, never rewritten.
 *
 * `kind` is what keeps the gate honest: only an in-scope employee with no
 * stub (`refusal`) can block a commit. A `warning` rides a stub that exists
 * (an entitlement bank over its limit — correct output the operator decides
 * on), and `out-of-scope` is the run's own scope rule refusing someone it was
 * never meant to pay (a final-pay stranger); neither blocks.
 *
 * The index signature is deliberate room, not looseness: the holiday
 * attestation work extends these entries additively (holiday keys, needed
 * facts) without reshaping what commit already binds to.
 */
export interface PayRunCalculationError {
  employeePartyId: string;
  employee: string;
  message: string;
  kind: "refusal" | "warning" | "out-of-scope";
  [key: string]: unknown;
}

/**
 * A recorded decision to commit a run that leaves in-scope employees unpaid.
 *
 * `errorsDigest` binds the acknowledgement to the EXACT in-scope refusal set
 * it names (see `payRunRefusalDigest`): acknowledging one refusal set and
 * then recalculating into another leaves a stale acknowledgement the commit
 * gate refuses, so an operator can never wave through a situation they did
 * not see. `refusals` is the human-readable half — who was left out and why,
 * retrievable long after posting.
 */
export interface PayRunRefusalAcknowledgement {
  version: 1;
  acknowledgedBy: string;
  acknowledgedAt: string;
  errorsDigest: string;
  refusals: PayRunCalculationError[];
}

/** The in-scope refusals inside a stored error set — what the gate binds to. */
export function payRunCalculationRefusals(
  errors: PayRunCalculationError[],
): PayRunCalculationError[] {
  return errors.filter((entry) => entry.kind === "refusal");
}

/**
 * Digest of an in-scope refusal set, sorted by party so entry order can never
 * distinguish two identical sets. The acknowledgement records this digest and
 * commit recomputes it; any recalculation that changes who is refused (or
 * why, the messages are digested too) invalidates the old acknowledgement.
 */
export function payRunRefusalDigest(refusals: PayRunCalculationError[]): string {
  const ordered = [...refusals].sort((a, b) =>
    a.employeePartyId < b.employeePartyId ? -1 : a.employeePartyId > b.employeePartyId ? 1 : 0,
  );
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

/**
 * Parse the persisted calculation errors. Null (legacy runs calculated before
 * refusal tracking, or never calculated) is NOT the same as empty: callers
 * must send the run through a recalculation rather than assume nobody was
 * refused. Corrupt entries fail the same closed way.
 */
export function parsePayRunCalculationErrors(
  value: unknown,
): PayRunCalculationError[] | null {
  if (value == null) return null;
  const raw = typeof value === "string" ? (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  })() : value;
  if (!Array.isArray(raw)) return null;
  const parsed: PayRunCalculationError[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.employeePartyId !== "string" || typeof record.employee !== "string"
        || typeof record.message !== "string"
        || (record.kind !== "refusal" && record.kind !== "warning" && record.kind !== "out-of-scope")) {
      return null;
    }
    parsed.push({ ...record } as PayRunCalculationError);
  }
  return parsed;
}

/** Parse a stored refusal acknowledgement; corrupt or absent reads as none. */
export function parsePayRunRefusalAcknowledgement(
  value: unknown,
): PayRunRefusalAcknowledgement | null {
  if (value == null) return null;
  const raw = typeof value === "string" ? (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  })() : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || typeof record.acknowledgedBy !== "string"
      || typeof record.acknowledgedAt !== "string" || typeof record.errorsDigest !== "string"
      || parsePayRunCalculationErrors(record.refusals) == null) {
    return null;
  }
  return {
    version: 1,
    acknowledgedBy: String(record.acknowledgedBy),
    acknowledgedAt: String(record.acknowledgedAt),
    errorsDigest: String(record.errorsDigest),
    refusals: parsePayRunCalculationErrors(record.refusals) ?? [],
  };
}
