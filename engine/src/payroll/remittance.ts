import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { civilDateFromParts, daysInCivilMonth, isIsoCalendarDate } from "../platform/business-date.ts";
import { add, cmp, div, formatMoney, mulRate, neg, roundMoney, sum } from "../money/money.ts";
import {
  filingAccountRef,
  type FilingAccountRef,
  type PayrollFilingAccount,
} from "./filing.ts";
import {
  addBusinessDays,
  holidayDateSet,
  nextBusinessDay,
  resolveObservedHolidays,
} from "./holidays.ts";
import { PayrollError } from "./error.ts";
import {
  allRemittanceSchedules,
  PAYROLL_COUNTRY_PACKS,
  remittanceBandForAverage,
  remittanceFrequencyBand,
  remittanceScheduleInForce,
  statutoryRemittanceDeclaration,
  type PayrollRemittanceFrequencyBand,
  type PayrollRemittanceSchedule,
  type StatutoryRemittanceDeclaration,
} from "./packs.ts";
import { payrollSubsidiaryInScope, payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";

type RemittanceExecutor = Pick<typeof db, "execute">;

/**
 * Payroll remittance execution — the PD7A-shaped bridge from accrued
 * withholding liabilities to money out the door.
 *
 * Committed pay runs credit each component's liability account; a remittance
 * run sums those amounts for a period, grouped by remittance destination
 * (the component's remittance party — union funds set theirs on their
 * auto-provisioned components; CA statutory components fall back to the org's
 * CRA remittance vendor) AND by the employees' payroll filing account, and
 * materializes one vendor bill per (destination, filing account, legal
 * entity) that DEBITS the liability accounts. A group spanning several
 * entities splits into one bill per entity — each stamped with the entity
 * whose books credited its accruals, in that entity's currency — because a
 * bill debiting entity A's books can never clear liabilities credited on
 * entity B's. The bill then rides the normal AP review/post/pay
 * machinery — payroll never grows a second payment path.
 *
 * Grouping by filing account is what makes a multi-account employer correct: a
 * PD7A is filed per payroll program account (…RP0001, …RP0002), so amounts
 * withheld from RP0002's employees must never be remitted under RP0001. Orgs
 * with no filing accounts configured land in one unassigned group, which is
 * byte-for-byte the previous single-account behaviour.
 */

export interface RemittanceComponentLine {
  componentId: string;
  code: string;
  name: string;
  kind: "deduction" | "employer_contribution" | "credit";
  systemKey: string | null;
  liabilityAccountId: string | null;
  accountLabel: string | null;
  amount: string;
  /** The ISO 4217 currency `amount` is stated in — the consolidated group's
   *  currency for group lines, the slice's currency for slice lines. */
  currency: string;
}

/**
 * One legal entity's share of a remittance group, in that entity's own
 * currency. A group stays keyed (destination, filing account) with
 * consolidated totals for the PD7A worksheet; the slices are the WRITE path —
 * a vendor bill is a single-entity AP document, so the bill creator raises
 * one bill per slice, stamped with the slice's subsidiary and currency.
 * Slice amounts are native accrual units (never translated): every stub in a
 * slice accrues in its entity's currency, so the slice total is what the
 * bill debits, to the cent.
 */
export interface RemittanceEntitySlice {
  /** The entity whose books credited these accruals. Never null: a bill
   *  cannot be stamped without a legal entity, so accruals with no source
   *  entity stay in the consolidated group only and refuse at bill time. */
  subsidiaryId: string;
  /** Display name for operators choosing which entity's bill to raise. */
  subsidiaryName: string | null;
  /** The entity's base currency — the bill's currency. */
  currency: string;
  /** This entity's component lines in native units. */
  components: RemittanceComponentLine[];
  /** This entity's share in native units. */
  total: string;
  /** Live bills already raised that may cover this slice: exact
   *  subsidiary-marker matches plus legacy bills with no entity marker
   *  (which covered the consolidated group and fail closed at bill time). */
  existingBills: { documentId: string; documentNumber: string; status: string; total: string }[];
}

export interface RemittanceGroup {
  partyId: string | null;
  partyName: string | null;
  /** The payroll program/EIN account this remittance is filed under. */
  filingAccount: FilingAccountRef;
  /**
   * True when any accrual in the group comes from a committed stub whose
   * filing account was never attributed (legacy `unknown` source). The money
   * is real and stays in the totals, but the group is unfiled: no remittance
   * bill may be raised from it until those stubs are reconciled, and the
   * group must render as unfiled/unknown rather than as an attributed filer.
   */
  hasUnknownFilingAccount: boolean;
  /**
   * True when any accrual in the group comes from a source with no legal
   * entity (a pay run document with no subsidiary). That money stays in the
   * consolidated totals for visibility, but no bill may be raised from the
   * group until it is attributed: a vendor bill cannot be stamped without
   * an entity, and stamping the root would repeat this defect.
   */
  hasEntitylessAccruals: boolean;
  /**
   * The vendor settings keys that routed rows into this group (the pack or
   * regional declaration each row resolved through — never a jurisdiction).
   * Sorted, distinct, without nulls. Downstream schedule resolution keys off
   * this provenance, so a group whose rows arrived through a scheduled
   * destination's key is governed by that schedule whatever its party is.
   */
  vendorKeys: string[];
  /**
   * The destination's declared remittance schedule for the queried period —
   * authority, frequency, and the due date the bill will carry — or null when
   * no pack declares the destination (the legacy CRA-function path). A
   * scheduled destination NEVER inherits the filing account's CRA remitter
   * type: that registration is with another agency.
   */
  schedule: RemittanceGroupSchedule | null;
  /**
   * Sorted distinct stub regions behind this group. A tax authority's holiday
   * calendar can be region-sensitive, so the bill's due date is computed from
   * these — see `remittanceGroupRegionalCalendar`.
   */
  provinces: string[];
  /**
   * The pack-declared regional tax-administration calendar governing this
   * group's deadline, or null for the pack's national one. Derived once here,
   * from the group's own regions and the declaring pack, so the read path
   * (the agent's due-date forecast) and the write path (the bill) cannot
   * disagree about which calendar applies.
   */
  regionalCalendar: string | null;
  components: RemittanceComponentLine[];
  total: string;
  /**
   * The ISO 4217 currency the consolidated `components`, `total` and
   * `grossPayroll` are stated in. A scope whose committed stubs share one
   * currency states that native currency (a EUR-only scope under a GBP org
   * states EUR, never GBP); a multi-currency scope states the org's base
   * currency with `translated` set. Consumers must format with this
   * currency, never assume the org's base.
   */
  currency: string;
  /**
   * True when the consolidated amounts were translated into `currency`
   * through each period's derived consolidated average rate (or the summary
   * refused naming the missing pair). False means native units: no rate was
   * read and none was needed.
   */
  translated: boolean;
  /**
   * Per-entity slices for the WRITE path — one entry per legal entity whose
   * books credited the group's accruals, each in that entity's currency.
   * The consolidated `components`/`total`/`grossPayroll`/`employeeCount`
   * above are the READ path (the PD7A worksheet figure, per filing account)
   * and are unchanged by slicing: do not derive worksheet figures from
   * slices, and do not derive bills from the consolidated totals.
   */
  slices: RemittanceEntitySlice[];
  /** PD7A worksheet context: gross pay and employee count in the period,
   *  counted within this filing account (the PD7A is filed per account).
   *  Stated in `currency` above: a multi-currency scope is translated
   *  slice-by-slice through derived consolidated rates (or the summary
   *  refuses), never summed as raw units. */
  grossPayroll: string;
  employeeCount: number;
  /** Remittance bills already raised for this destination and period. */
  existingBills: { documentId: string; documentNumber: string; status: string; total: string }[];
}

/**
 * The destination schedule governing one remittance group: which declared
 * schedule, at which frequency, producing which bill due date. Every field is
 * data the pack declared or configuration the org set — the generic layer
 * names no jurisdiction to build it.
 */
export interface RemittanceGroupSchedule {
  /** The vendor settings key whose schedule governs (e.g. `rqRemittancePartyId`). */
  vendorSettingsKey: string;
  /** The receiving authority (e.g. `Revenu Québec`). */
  authority: string;
  /** The frequency the bill is dated under. */
  frequency: string;
  /** Whether the frequency is the org's configured value or the schedule default. */
  frequencySource: "configured" | "default";
  /** The bill due date for the group's period, from the destination's schedule. */
  dueDate: string;
  /** The statutory rule applied, carried onto the bill like the CRA rules. */
  rule: string;
}

/** The raw orgs.settings.payroll blob — indexed by whatever settings keys the
 *  pack declarations name, so this module needs no typed knowledge of them. */
async function rawPayrollSettings(
  orgId: string,
  executor: RemittanceExecutor = db,
): Promise<Record<string, unknown>> {
  const r = (await executor.execute<{ p: Record<string, unknown> | null }>(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}`,
  ));
  return r.rows[0]?.p ?? {};
}

/** Load filing-account labels through the caller's transaction when one is
 * active. A remittance bill must resolve its group and labels from the same
 * snapshot that supplies the accrued rows, not from a second pooled session. */
async function filingAccountsByIdIn(
  orgId: string,
  executor: RemittanceExecutor,
): Promise<Map<string, PayrollFilingAccount>> {
  const rows = await executor.execute<Record<string, unknown>>(sql`
    select id, country, program_type, account_number, name, remitter_type,
           subsidiary_id, state_code, is_default, is_active
      from payroll_filing_accounts
     where org_id = ${orgId}
     order by is_default desc, account_number
  `);
  return new Map(rows.rows.map((row) => [String(row.id), {
    id: String(row.id),
    country: String(row.country),
    programType: String(row.program_type),
    accountNumber: String(row.account_number),
    name: String(row.name),
    remitterType: row.remitter_type as PayrollFilingAccount["remitterType"],
    subsidiaryId: (row.subsidiary_id as string | null) ?? null,
    stateCode: (row.state_code as string | null) ?? null,
    isDefault: row.is_default === true,
    isActive: row.is_active === true,
  }]));
}

/**
 * Accrued-but-unremitted withholding by destination for pay dates in
 * [from, to] (committed and posted runs).
 *
 * Which system keys are internal accruals — liabilities that settle through a
 * payout to the employee, never through a remittance to anyone — is a PACK
 * declaration (`remittance: 'internal_accrual'` in engine/src/payroll/packs.ts),
 * not a spelled key. The CA pack declares `vacation_accrual`; a pack whose
 * statute banks a different accrual declares its own, and this module never
 * learns the words.
 */
/**
 * Resolve the derived consolidated average rate for every (currency, period)
 * a mixed-currency summary must translate, keyed `currency → periodId`.
 * Amounts translate ONLY through a stored consolidated row (derived at period
 * close or set by a controller override) — a missing row throws with the
 * trial balance's own message instead of being defaulted to 1.
 */
async function derivedAverageRates(
  orgId: string,
  presentation: string,
  needs: readonly { currency: string; periodId: string; periodEnd: string }[],
  executor: RemittanceExecutor,
): Promise<Map<string, string>> {
  const foreign = needs.filter((need) => need.currency !== presentation);
  if (foreign.length === 0) return new Map();
  const periodIds = [...new Set(foreign.map((need) => need.periodId))];
  const currencies = [...new Set(foreign.map((need) => need.currency))];
  const stored = (await executor.execute<{
    period_id: string; currency: string; average_rate: string;
  }>(sql`
    select period_id::text as period_id, from_currency as currency, average_rate::text as average_rate
      from consolidated_fx_rates
     where org_id = ${orgId} and to_currency = ${presentation}
       and period_id = any(${`{${periodIds.join(",")}}`}::uuid[])
       and from_currency = any(${`{${currencies.join(",")}}`}::text[])`));
  const byKey = new Map(stored.rows.map((row) => [`${row.currency}→${row.period_id}`, row.average_rate]));
  for (const need of foreign) {
    if (!byKey.has(`${need.currency}→${need.periodId}`)) {
      throw new PayrollError(
        `No consolidated exchange rates for ${need.currency} → ${presentation} in the period ending ${need.periodEnd}. Derive rates from period close first.`,
      );
    }
  }
  return byKey;
}

/**
 * The mixed-currency half of the remittance summary. When the period's
 * committed stubs span more than one currency, raw units must never be added:
 * every accrual and gross slice is translated to the organization's base
 * currency through the derived consolidated average rate of its own period,
 * or the summary refuses naming the missing pair. Single-currency scopes
 * never reach here, so their figures stay byte-identical.
 */
async function mixedCurrencyAccruals(
  orgId: string,
  range: { from: string; to: string },
  allowedSubsidiaryIds: PayrollSubsidiaryScope | undefined,
  executor: RemittanceExecutor,
  presentation: string,
  isInternalAccrual: (row: { systemKey: string | null; country: string | null }) => boolean,
): Promise<{
  rows: RemittanceRow[];
  contextByAccount: Map<string, { gross: string; employees: number }>;
}> {
  const filingAccount = sql`s.filing_account_id`;
  // Stubs whose pay date falls in no regular accounting period can be
  // neither translated nor summed: refusing names the date and why, instead
  // of silently dropping their money from the accruals below. The coverage
  // guard and the per-row lateral joins below carry the default-calendar
  // join inline (set-based form of the shared covering-period resolver:
  // same predicate, same deterministic ordering), because a row-wise
  // helper call cannot serve a grouped query.
  const dateless = (await executor.execute<{ pay_date: string; currency: string }>(sql`
    select s.pay_date::text as pay_date, s.currency_code as currency
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
       and not exists (
         select 1 from accounting_periods p
          join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
            and fc.is_default and fc.is_active
          where p.org_id = ${orgId} and not p.is_adjustment
            and p.starts_on <= s.pay_date and p.ends_on >= s.pay_date
       )
     limit 1`));
  if (dateless.rows[0]) {
    throw new PayrollError(
      `cannot translate ${dateless.rows[0].currency} payroll dated ${dateless.rows[0].pay_date}: ` +
        `no regular accounting period covers that date, so no derived consolidated rate can exist for it`,
    );
  }
  const slices = (await executor.execute<{
      component_id: string; code: string; name: string;
      kind: "deduction" | "employer_contribution" | "credit";
      system_key: string | null; country: string | null; remittance_party_id: string | null;
      liability_account_id: string | null; filing_account_id: string | null;
      filingUnknown: boolean; province: string; subsidiary_id: string | null;
      currency: string; period_id: string; period_end: string; amount: string;
    }>(sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
           l.liability_account_id,
           ${filingAccount} as filing_account_id,
           bool_or(s.filing_account_source = 'unknown') as "filingUnknown",
           s.province,
           source_document.subsidiary_id,
           s.currency_code as currency,
           period.id as period_id, period.ends_on::text as period_end,
           sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
      join lateral (
        select p.id, p.ends_on from accounting_periods p
          join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
            and fc.is_default and fc.is_active
         where p.org_id = ${orgId} and not p.is_adjustment
           and p.starts_on <= s.pay_date and p.ends_on >= s.pay_date
         order by p.starts_on, p.ends_on, p.id limit 1
      ) period on true
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by c.id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
              l.liability_account_id, ${filingAccount}, s.province,
              source_document.subsidiary_id,
              s.currency_code, period.id, period.ends_on
     order by c.sequence, c.code
  `));
  const grossSlices = (await executor.execute<{
      filing_account_id: string | null; currency: string;
      period_id: string; period_end: string; gross: string;
    }>(sql`
    select ${filingAccount} as filing_account_id, s.currency_code as currency,
           period.id as period_id, period.ends_on::text as period_end,
           sum(s.gross) as gross
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
      join lateral (
        select p.id, p.ends_on from accounting_periods p
          join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
            and fc.is_default and fc.is_active
         where p.org_id = ${orgId} and not p.is_adjustment
           and p.starts_on <= s.pay_date and p.ends_on >= s.pay_date
         order by p.starts_on, p.ends_on, p.id limit 1
      ) period on true
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by ${filingAccount}, s.currency_code, period.id, period.ends_on
  `));
  const rates = await derivedAverageRates(
    orgId,
    presentation,
    [
      ...slices.rows.map((row) => ({ currency: row.currency, periodId: row.period_id, periodEnd: row.period_end })),
      ...grossSlices.rows.map((row) => ({ currency: row.currency, periodId: row.period_id, periodEnd: row.period_end })),
    ],
    executor,
  );
  const translate = (amount: string, currency: string, periodId: string): string => {
    if (currency === presentation) return amount;
    const rate = rates.get(`${currency}→${periodId}`);
    if (!rate) {
      throw new PayrollError(
        `No consolidated exchange rates for ${currency} → ${presentation}. Derive rates from period close first.`,
      );
    }
    return roundMoney(mulRate(amount, rate), 2);
  };
  const rows: RemittanceRow[] = slices.rows
    .filter((row) => !isInternalAccrual({ systemKey: row.system_key, country: row.country }))
    .map((row) => ({
      component_id: row.component_id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      system_key: row.system_key,
      country: row.country,
      remittance_party_id: row.remittance_party_id,
      liability_account_id: row.liability_account_id,
      filing_account_id: row.filing_account_id,
      filingUnknown: row.filingUnknown,
      province: row.province,
      subsidiary_id: row.subsidiary_id,
      currency: row.currency,
      // Native units for the entity slice; translated units for the
      // consolidated group. A credit nets against the destination in both
      // readings, so the negation below applies to both.
      sliceAmount: row.kind === "credit" ? neg(row.amount) : row.amount,
      amount: translate(row.amount, row.currency, row.period_id),
    }))
    .map((row) => (row.kind === "credit" ? { ...row, amount: neg(row.amount) } : row));
  const headcounts = (await executor.execute<{
      filing_account_id: string | null; employees: number;
    }>(sql`
    select ${filingAccount} as filing_account_id,
           count(distinct s.employee_party_id)::int as employees
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by ${filingAccount}
  `));
  const grossByAccount = new Map<string, string>();
  for (const slice of grossSlices.rows) {
    const key = slice.filing_account_id ?? "";
    grossByAccount.set(key, add(grossByAccount.get(key) ?? "0", translate(slice.gross, slice.currency, slice.period_id)));
  }
  const contextByAccount = new Map<string, { gross: string; employees: number }>(
    headcounts.rows.map((row) => [
      row.filing_account_id ?? "",
      { gross: grossByAccount.get(row.filing_account_id ?? "") ?? "0", employees: row.employees },
    ]),
  );
  return { rows, contextByAccount };
}

/**
 * The narrow row shape destination resolution reads — shared by the summary
 * (which folds grouped rows) and bill creation (which resolves individual
 * accrual lines for coverage), so the two can never disagree about who an
 * accrual remits to.
 */
export interface RemittanceResolvableRow {
  /** The stub line's commit-time destination snapshot (migration 0296). */
  snapshotPartyId: string | null;
  systemKey: string | null;
  country: string | null;
  province: string;
}

/**
 * Destination resolution over commit-time snapshots, extracted so the summary
 * and the bill creator share one implementation. Country-first pack lookup
 * (two packs may give the same withholding the same system key, so the
 * country stamped on the component row picks the pack), exactly as the
 * summary always resolved.
 */
export function makeRemittanceDestinationResolver(
  payrollSettings: Record<string, unknown>,
): {
  resolveDestination: (row: RemittanceResolvableRow) => { partyId: string | null; vendorKey: string | null };
  isInternalAccrual: (row: Pick<RemittanceResolvableRow, "systemKey" | "country">) => boolean;
} {
  const declarations = new Map<string, StatutoryRemittanceDeclaration | null>();
  const declarationFor = (country: string | null): StatutoryRemittanceDeclaration | null => {
    if (!country) return null;
    const hit = declarations.get(country);
    if (hit !== undefined) return hit;
    const found = PAYROLL_COUNTRY_PACKS[country] ? statutoryRemittanceDeclaration(country) : null;
    declarations.set(country, found);
    return found;
  };
  const settingsVendor = (settingsKey: string): string | null => {
    const vendor = payrollSettings[settingsKey];
    return typeof vendor === "string" && vendor ? vendor : null;
  };
  return {
    resolveDestination: (row) => {
      const packDeclaration = row.systemKey ? declarationFor(row.country) : null;
      const regionalKey = row.systemKey
        ? packDeclaration?.regionalVendorSettingsKeyBySystemKey.get(row.systemKey)?.[row.province]
        : undefined;
      // The regional key is provenance even when the org has not configured
      // the vendor yet: an unconfigured RQ destination is still an RQ
      // destination — it surfaces unassigned under the RQ schedule, never
      // under the CRA one.
      if (regionalKey) return { partyId: settingsVendor(regionalKey), vendorKey: regionalKey };
      // The SNAPSHOT, never the live component: a vendor edited after commit
      // cannot re-point this accrual.
      if (row.snapshotPartyId) return { partyId: row.snapshotPartyId, vendorKey: null };
      const vendorKey = row.systemKey
        ? packDeclaration?.vendorSettingsKeyBySystemKey.get(row.systemKey)
        : undefined;
      if (!vendorKey) return { partyId: null, vendorKey: null };
      return { partyId: settingsVendor(vendorKey), vendorKey };
    },
    isInternalAccrual: (row) =>
      row.systemKey != null
      && (declarationFor(row.country)?.internalAccrualSystemKeys.includes(row.systemKey) ?? false),
  };
}

/**
 * The period's own validity, before any row is read. Shape alone admits
 * impossible dates ('2026-02-30', month 13) that PostgreSQL then refuses
 * with a driver error instead of a named refusal — so the range is proven a
 * real calendar date pair first, at every entry point that accepts one.
 * Pure, so the rule is verifiable without a database.
 */
export function remittancePeriodProblem(from: unknown, to: unknown): string | null {
  if (!isIsoCalendarDate(from)) {
    return `invalid from (YYYY-MM-DD calendar date required) — got ${JSON.stringify(from) ?? "nothing"}`;
  }
  if (!isIsoCalendarDate(to)) {
    return `invalid to (YYYY-MM-DD calendar date required) — got ${JSON.stringify(to) ?? "nothing"}`;
  }
  if (to < from) {
    return `from "${from}" is after to "${to}" — the period must start on or before it ends`;
  }
  return null;
}

export async function payrollRemittanceSummary(
  orgId: string,
  range: { from: string; to: string },
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
  executor: RemittanceExecutor = db,
): Promise<RemittanceGroup[]> {
  const periodProblem = remittancePeriodProblem(range.from, range.to);
  if (periodProblem) throw new PayrollError(periodProblem);
  const rawSettings = await rawPayrollSettings(orgId, executor);
  // No org-wide unknown-filing-account refusal here: one legacy run must not
  // poison the summary for the rest. Stubs whose filing account was never
  // attributed carry a null account into the unassigned group and flag it
  // (hasUnknownFilingAccount); only bill creation for a flagged group fails
  // closed, until those stubs are reconciled.
  const filingAccount = sql`s.filing_account_id`;
  // One shared destination resolver for the summary AND the bill creator's
  // coverage reads: pack declarations are resolved country-first (two packs
  // may give the same withholding the same system key, so the country
  // stamped on the component row picks the pack), and internal accruals
  // (liabilities that settle through employee payout, never remittance) are
  // excluded by the same predicate in both paths.
  const sharedResolution = makeRemittanceDestinationResolver(rawSettings);
  // Every group states its own currency (RemittanceGroup.currency): a scope
  // whose committed stubs share one currency states that native currency —
  // even when it differs from the org's base — and a scope spanning more
  // than one currency takes the mixed-currency path (translate each slice
  // through its own period's derived consolidated rate, or refuse naming the
  // missing pair) and states the org's base with `translated` set. A
  // single-currency scope keeps the historical queries below verbatim, so
  // its figures stay byte-identical.
  const presentation = (await executor.execute<{ base_currency: string }>(sql`
    select base_currency from orgs where id = ${orgId}`)).rows[0]?.base_currency ?? null;
  const scopeCurrencies = presentation
    ? (await executor.execute<{ currency: string }>(sql`
      select distinct s.currency_code as currency
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
        join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
       where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
         ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}`))
        .rows.map((row) => row.currency)
    : [];
  let rows: RemittanceRow[];
  let contextByAccount: Map<string, { gross: string; employees: number }>;
  // The consolidated presentation currency, set only when the mixed path
  // below translates into the org's base. A single-currency scope states its
  // native currency per group instead — even a foreign one.
  let presentationCurrency: string | undefined;
  if (scopeCurrencies.length > 1 && presentation) {
    ({ rows, contextByAccount } = await mixedCurrencyAccruals(
      orgId, range, allowedSubsidiaryIds, executor, presentation, sharedResolution.isInternalAccrual,
    ));
    presentationCurrency = presentation;
  } else {
  // Grouped by the STUB's snapshot province as well as by component: a
  // component whose pack declares a region-scoped remittance vendor (QPP and
  // QPIP go to Revenu Québec for QC employment, to the CRA nowhere) splits by
  // destination, and rows that resolve to the same vendor are re-merged per
  // component in groupRemittanceRows.
  const queried = (await executor.execute<{
      component_id: string; code: string; name: string;
      kind: "deduction" | "employer_contribution" | "credit";
      system_key: string | null; country: string | null; remittance_party_id: string | null;
      liability_account_id: string | null; filing_account_id: string | null;
      filingUnknown: boolean; province: string; subsidiary_id: string | null;
      currency: string; amount: string;
    }>(sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
           -- Historical accrual evidence only. Current component or statutory
           -- account setup cannot establish where an older liability accrued,
           -- and the CURRENT component vendor cannot establish who an older
           -- accrual remits to: both are the stub line's commit-time snapshot.
           l.liability_account_id,
           ${filingAccount} as filing_account_id,
           bool_or(s.filing_account_source = 'unknown') as "filingUnknown",
           s.province,
           -- The WRITE path's grouping dimension: which entity's books
           -- credited the accrual, and in which currency. Splitting rows by
           -- entity changes nothing consolidated — groupRemittanceRows folds
           -- them back — so single-entity figures stay byte-identical.
           source_document.subsidiary_id,
           s.currency_code as currency,
           sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
      join documents source_document on source_document.id=r.document_id and source_document.org_id=r.org_id
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by c.id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
              l.liability_account_id, ${filingAccount}, s.province,
              source_document.subsidiary_id, s.currency_code
     order by c.sequence, c.code
  `));
  // Internal accruals never remit, and each pack declares its own — so the
  // exclusion is per component country, not per system key. Rows with no
  // system key (user components) always stay in the summary.
  // A `credit` row is money the employer reclaims from the destination, so it
  // nets AGAINST the group's withholdings (F24 compensation): the summary's
  // group total is what the employer actually sends, never the gross levy.
  // The slice amount rides along natively: this path is single-currency, so
  // it agrees with the consolidated amount by construction.
  rows = queried.rows
    .filter((row) => !sharedResolution.isInternalAccrual({ systemKey: row.system_key, country: row.country }))
    .map((row) => ({
      ...row,
      sliceAmount: row.kind === "credit" ? neg(row.amount) : row.amount,
    }))
    .map((row) => (row.kind === "credit" ? { ...row, amount: neg(row.amount) } : row));

  const context = (await executor.execute<{ filing_account_id: string | null; gross: string; employees: number }>(sql`
    select ${filingAccount} as filing_account_id,
           coalesce(sum(s.gross), 0) as gross,
           count(distinct s.employee_party_id)::int as employees
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id=r.document_id and source_document.org_id=r.org_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by ${filingAccount}
  `));
  contextByAccount = new Map(
    context.rows.map((row) => [row.filing_account_id ?? "", row]),
  );
  }
  if (rows.length === 0) return [];
  if (rows.some(row => !row.liability_account_id && cmp(row.amount, "0") !== 0)) {
    throw new PayrollError("Committed payroll has an unknown historical liability account. Reconcile its original payroll posting evidence before generating remittance reports or bills.");
  }
  const filingAccounts = await filingAccountsByIdIn(orgId, executor);

  // Destination resolves through the pack declarations over the stub line's
  // commit-time snapshot (migration 0296) — never the live component. A
  // REGION-scoped vendor declaration for the stub's province (QPP/QPIP → the
  // Revenu Québec vendor for QC stubs) resolves FIRST, outranking even the
  // snapshot, because that column is one value on a component whose amounts
  // split by destination. Otherwise a `tax_authority` component falls back to
  // the vendor named by ITS pack's remittanceVendorSettingsKey (the CRA
  // remittance vendor for the CA pack; a pack that declares none surfaces
  // unassigned for setup, which is where the US statutory components have
  // always landed). An `external` component (WCB, SUTA) only ever uses its
  // own snapshot party.
  const resolver = sharedResolution;
  const toResolvable = (row: (typeof rows)[number]): RemittanceResolvableRow => ({
    snapshotPartyId: row.remittance_party_id,
    systemKey: row.system_key,
    country: row.country,
    province: row.province,
  });
  const resolveDestination = (row: (typeof rows)[number]): { partyId: string | null; vendorKey: string | null } =>
    resolver.resolveDestination(toResolvable(row));
  const resolveParty = (row: (typeof rows)[number]): string | null => resolveDestination(row).partyId;
  const resolveVendorKey = (row: (typeof rows)[number]): string | null => resolveDestination(row).vendorKey;
  const resolveAccount = (row: (typeof rows)[number]): string | null =>
    row.liability_account_id;

  // Slice labelling: every accrual names its entity, and the entity names
  // its currency. Read from the same snapshot as the rows above.
  const subsidiaryRows = (await executor.execute<{ id: string; name: string | null; currency: string | null }>(sql`
    select id::text as id, name, base_currency as currency from subsidiaries
     where org_id = ${orgId} and is_active
  `));
  const subsidiaries = new Map(
    subsidiaryRows.rows.map((s) => [s.id, { name: s.name, currency: s.currency }]),
  );

  const groups = groupRemittanceRows({
    rows, contextByAccount, filingAccounts, resolveParty, resolveAccount, resolveVendorKey,
    subsidiaries,
    presentationCurrency,
  });

  // One group, one destination, one schedule. Provenance first: rows that
  // arrived through a scheduled destination's vendor key are governed by that
  // schedule. Otherwise a group whose PARTY is a scheduled destination's
  // configured vendor (an `external` component pointed at the RQ vendor)
  // resolves through the party. Anything else keeps the legacy CRA path.
  const schedules = allRemittanceSchedules();
  for (const group of groups.values()) {
    group.schedule = scheduleForRemittanceGroup({
      vendorKeys: group.vendorKeys,
      partyId: group.partyId,
      periodTo: range.to,
      payrollSettings: rawSettings,
      schedules,
    });
  }

  // Names + account labels + prior bills for the same destination and any
  // overlapping period. Loading the complete marker window lets callers show
  // that an accrual is already covered even when their requested range is
  // wider or narrower than the bill that consumed it.
  const partyIds = [...new Set([...groups.values()].map((g) => g.partyId).filter(Boolean))] as string[];
  const accountIds = [...new Set(
    [...groups.values()].flatMap((g) => g.components.map((c) => c.liabilityAccountId)).filter(Boolean),
  )] as string[];
  // Run these reads sequentially when `executor` is a transaction. Drizzle's
  // transaction client is one PostgreSQL connection; Promise.all would queue
  // concurrent queries on that connection and can produce an overlapping
  // client.query warning while providing no snapshot benefit.
  const parties = partyIds.length
    ? await executor.execute<{ id: string; display_name: string }>(sql`select id, display_name from parties
                      where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
    : { rows: [] };
  const accounts = accountIds.length
    ? await executor.execute<{ id: string; number: string | null; name: string }>(sql`select id, number, name from accounts
                      where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`)
    : { rows: [] };
  const bills = await executor.execute<{
      id: string; document_number: string; status: string; total: string;
      party_id: string | null; filing_account_id: string | null;
      subsidiary_id: string | null; from: string | null; to: string | null;
    }>(sql`
    select id, document_number, status, total, party_id,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id,
           custom->'payrollRemittance'->>'subsidiaryId' as subsidiary_id,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to
      from documents
     where org_id = ${orgId} and kind = 'vendor_bill'
       and custom->'payrollRemittance'->>'from' <= ${range.to}
       and custom->'payrollRemittance'->>'to' >= ${range.from}
       and status <> 'voided'
       ${payrollSubsidiaryScopeFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}`);
  const partyName = new Map(parties.rows.map((p) => [p.id, p.display_name]));
  const accountLabel = new Map(accounts.rows.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]));
  for (const group of groups.values()) {
    group.partyName = group.partyId ? (partyName.get(group.partyId) ?? null) : null;
    for (const component of group.components) {
      component.accountLabel = component.liabilityAccountId
        ? (accountLabel.get(component.liabilityAccountId) ?? null) : null;
    }
    for (const slice of group.slices) {
      for (const component of slice.components) {
        component.accountLabel = component.liabilityAccountId
          ? (accountLabel.get(component.liabilityAccountId) ?? null) : null;
      }
    }
    const matched = bills.rows.filter((b) =>
      b.from != null && b.to != null
      && b.from <= range.to && b.to >= range.from
      &&
      groupKey(b.party_id ?? null, b.filing_account_id) ===
        groupKey(group.partyId, group.filingAccount.id));
    group.existingBills = matched
      .map((b) => ({ documentId: b.id, documentNumber: b.document_number, status: b.status, total: b.total }));
    // Each slice sees its own bills plus legacy bills with no entity marker
    // (which covered the consolidated group and may cover this slice — the
    // bill creator fails closed on them rather than guessing).
    for (const slice of group.slices) {
      slice.existingBills = matched
        .filter((b) => b.subsidiary_id == null || b.subsidiary_id === slice.subsidiaryId)
        .map((b) => ({ documentId: b.id, documentNumber: b.document_number, status: b.status, total: b.total }));
    }
  }
  return [...groups.values()].sort((a, b) =>
    (a.partyName ?? "￿").localeCompare(b.partyName ?? "￿")
    || (a.filingAccount.accountNumber ?? "").localeCompare(b.filingAccount.accountNumber ?? ""));
}

/**
 * Reconcile a remittance bill against the committed payroll it snapshots.
 *
 * A bill is deliberately created as a normal AP draft, so payroll can be
 * voided or another run can commit while that draft waits for review. Posting
 * is the irreversible boundary: lock every pay run in the marked period,
 * re-read the bill marker, then prove every line this bill consumed is still
 * a live committed accrual for this bill's vendor. The source locks serialize
 * this check with both commit and controlled payroll voids; a stale draft
 * therefore fails closed instead of becoming an over-remittance through the
 * generic AP poster.
 *
 * Growth never blocks: accruals committed after the bill only extend the
 * scope, and a later incremental bill consumes them. Only the bill's OWN
 * covered lines are liveness-checked — a covered line that vanished (void),
 * changed amount (amendment), or now resolves elsewhere (settings moved it)
 * refuses by name. A bill with no coverage rows at all predates the coverage
 * write and keeps the legacy whole-scope total comparison.
 */
export async function assertPayrollRemittanceBillCurrent(
  orgId: string,
  documentId: string,
  executor: RemittanceExecutor = db,
): Promise<void> {
  const marker = (await executor.execute<{
    party_id: string | null;
    total: string;
    document_number: string | null;
    from: string | null;
    to: string | null;
    filing_account_id: string | null;
    subsidiary_id: string | null;
  }>(sql`
    select party_id::text as party_id, total::text as total,
           document_number,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id,
           custom->'payrollRemittance'->>'subsidiaryId' as subsidiary_id
      from documents
     where org_id = ${orgId} and id = ${documentId}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
  `)).rows[0];
  if (!marker) return;
  if (
    !marker.party_id
    || !marker.from
    || !marker.to
    || !/^\d{4}-\d{2}-\d{2}$/.test(marker.from)
    || !/^\d{4}-\d{2}-\d{2}$/.test(marker.to)
    || marker.from > marker.to
    || (marker.filing_account_id !== null && !/^[0-9a-f-]{36}$/i.test(marker.filing_account_id))
  ) {
    throw new PayrollError("payroll remittance bill has an invalid source marker");
  }

  // Lock source runs and their documents BEFORE locking the bill below. The
  // controlled void path already owns a source document before it inspects
  // posted remittance bills, so this order makes the two boundaries queue
  // rather than deadlock.
  await executor.execute(sql`
    select r.document_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId}
       and r.pay_date between ${marker.from} and ${marker.to}
     order by r.document_id
     for update of r, d
  `);

  const locked = (await executor.execute<{
    party_id: string | null;
    total: string;
    document_number: string | null;
    from: string | null;
    to: string | null;
    filing_account_id: string | null;
    subsidiary_id: string | null;
  }>(sql`
    select party_id::text as party_id, total::text as total,
           document_number,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id,
           custom->'payrollRemittance'->>'subsidiaryId' as subsidiary_id
      from documents
     where org_id = ${orgId} and id = ${documentId}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
     for update
  `)).rows[0];
  if (!locked || !locked.party_id || !locked.from || !locked.to) {
    throw new PayrollError("payroll remittance bill has an invalid source marker");
  }
  const billName = locked.document_number ?? "unnumbered";

  const coverage = (await executor.execute<{ stub_line_id: string; amount: string }>(sql`
    select cov.stub_line_id::text as stub_line_id, cov.amount::text as amount
      from payroll_remittance_coverage cov
     where cov.org_id = ${orgId} and cov.bill_document_id = ${documentId}
     order by cov.stub_line_id
  `)).rows;

  if (coverage.length === 0) {
    // A bill with no coverage rows predates the coverage write: reconcile
    // the whole scope exactly as before, failing closed on any drift.
    const groups = await payrollRemittanceSummary(
      orgId,
      { from: locked.from, to: locked.to },
      undefined,
      executor,
    );
    const group = groups.find((candidate) =>
      candidate.partyId === locked.party_id
      && candidate.filingAccount.id === (locked.filing_account_id ?? null));
    if (!group) {
      throw new PayrollError(
        "payroll remittance source is no longer committed; regenerate this bill",
      );
    }
    // An entity-stamped bill reconciles against its own slice (native units);
    // a legacy bill with no entity marker reconciles against the consolidated
    // group exactly as before.
    const expected = locked.subsidiary_id
      ? group.slices.find((slice) => slice.subsidiaryId === locked.subsidiary_id)?.total ?? null
      : group.total;
    if (expected == null || cmp(expected, locked.total) !== 0) {
      throw new PayrollError(
        "payroll remittance bill no longer matches committed payroll; regenerate this bill",
      );
    }
    return;
  }

  // Every line this bill consumed must still be a committed accrual with the
  // same amount, resolving to this bill's vendor through live settings. A
  // voided or amended-away line is gone; a settings-moved line resolves
  // elsewhere; both refuse naming the bill and the remedy. Scope growth
  // (accruals committed after the bill) is invisible here by construction:
  // uncovered lines are simply not the bill's.
  const live = (await executor.execute<{
    line_id: string; kind: "deduction" | "employer_contribution" | "credit";
    amount: string; snapshot_party_id: string | null;
    system_key: string | null; country: string | null; province: string;
  }>(sql`
    select l.id::text as line_id, l.kind, l.amount::text as amount,
           l.remittance_party_id::text as snapshot_party_id,
           c.system_key, c.country, s.province
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.id = any(${`{${coverage.map((row) => row.stub_line_id).join(",")}}`}::uuid[])
  `));
  const liveById = new Map(
    live.rows.map((row) => [row.line_id, {
      snapshotPartyId: row.snapshot_party_id,
      systemKey: row.system_key,
      country: row.country,
      province: row.province,
    } satisfies RemittanceResolvableRow]),
  );
  const liveAmounts = new Map(live.rows.map((row) => [row.line_id, row.amount]));
  const resolution = makeRemittanceDestinationResolver(await rawPayrollSettings(orgId, executor));
  let gone = 0;
  let changed = 0;
  for (const covered of coverage) {
    const row = liveById.get(covered.stub_line_id);
    if (
      !row
      || resolution.isInternalAccrual(row)
      || resolution.resolveDestination(row).partyId !== locked.party_id
    ) {
      gone += 1;
    } else if (cmp(liveAmounts.get(covered.stub_line_id)!, covered.amount) !== 0) {
      changed += 1;
    }
  }
  const stale = (count: number, what: string): string =>
    `${count} of its ${coverage.length} covered ${count === 1 ? "line has" : "lines have"} ${what}`;
  if (gone > 0 || changed > 0) {
    const causes = [
      gone > 0 ? stale(gone, "left committed payroll (voided, amended away, or re-pointed to another vendor)") : null,
      changed > 0 ? stale(changed, "a different amount than the bill consumed") : null,
    ].filter((cause): cause is string => cause !== null);
    throw new PayrollError(
      `payroll remittance bill ${billName} no longer matches its committed source: `
      + `${causes.join("; ")}; void this draft and raise a fresh bill`,
    );
  }
  // Receipt: the bill's own total must equal its verified coverage, so a
  // hand-edited bill total cannot post against a stale-but-live source.
  if (cmp(sum(coverage.map((row) => row.amount)), locked.total) !== 0) {
    throw new PayrollError(
      `payroll remittance bill ${billName} no longer matches its committed source: `
      + `its total differs from the lines it consumed; void this draft and raise a fresh bill`,
    );
  }
}

export class RemittanceSourceIntegrityError extends Error {}

/**
 * Caller holds the document revision lock. A remittance bill's lines are
 * generated from its recorded coverage (one line per consumed accrual, named
 * for its component and period): hand-editing them breaks the receipt the
 * posting check reconciles, so any line replacement refuses by name. Header
 * edits (memo, dates, dimensions) proceed normally.
 * Returns true for remittance bills (whose stored lines the editor must
 * keep), false for every other document.
 */
export async function assertRemittanceBillEdit(
  tx: RemittanceExecutor,
  orgId: string,
  id: string,
  preparedLines: unknown[] | null,
): Promise<boolean> {
  const bill = (await tx.execute<{ document_number: string | null }>(sql`
    select document_number
      from documents
     where org_id = ${orgId} and id = ${id}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
  `)).rows[0];
  if (!bill) return false;
  if (preparedLines === null) return true;
  throw new RemittanceSourceIntegrityError(
    `remittance bill ${bill.document_number ?? "unnumbered"} is generated from its payroll source — `
    + "its lines cannot be edited; void or delete this draft and raise a fresh bill from Payroll → Remittances",
  );
}

/** One remittance group = one destination vendor under one filing account. */
function groupKey(partyId: string | null, filingAccountId: string | null): string {
  return `${partyId ?? ""}::${filingAccountId ?? ""}`;
}

/** A withholding total for one component under one filing account, per stub
 *  province — the province is what a region-scoped remittance declaration
 *  (QPP/QPIP → Revenu Québec) resolves the destination from. */
export type RemittanceRow = {
  component_id: string;
  code: string;
  name: string;
  kind: "deduction" | "employer_contribution" | "credit";
  system_key: string | null;
  /** The component row's pack country — picks the pack whose declaration governs the row. */
  country: string | null;
  /** The stub line's commit-time destination snapshot (migration 0296) — the
   * vendor the accrual remitted to when it committed, never the component's
   * vendor today. Null for lines whose component named no vendor (which fall
   * through to the pack's configured vendor, exactly as before). */
  remittance_party_id: string | null;
  liability_account_id: string | null;
  filing_account_id: string | null;
  /** True when any stub behind the row never had its filing account attributed. */
  filingUnknown: boolean;
  province: string;
  /**
   * The legal entity whose books credited this accrual — the pay run
   * document's subsidiary. Null only for legacy rows that predate entity
   * pinning; such money stays consolidated and refuses at bill time.
   */
  subsidiary_id: string | null;
  /** The stub's accrual currency (its entity's currency in practice). */
  currency: string;
  /**
   * This row's contribution to its ENTITY slice in native units. The `amount`
   * above is the consolidated contribution (translated to the org base in a
   * mixed-currency scope, native otherwise); the two agree whenever the
   * scope is single-currency. Bills sum `sliceAmount`, never `amount`.
   */
  sliceAmount: string;
  amount: string;
};

/**
 * The regional tax-administration calendar a remittance group's deadline
 * moves against, or `null` for the pack's national one.
 *
 * Non-null exactly when every stub region behind the group is the SAME
 * region and the pack declares a calendar for it
 * (`remittanceRegionalCalendars`). A payroll worked wholly in one such
 * region remits on that region's schedule; anything else — another region, a
 * mix, or no evidence at all — keeps the national calendar the bill always
 * used. A mixed payroll's governing region is the employer's region of
 * record, which the product does not model, so mixing never flips the
 * calendar by itself.
 *
 * The region and the calendar key are both the PACK's, never this module's.
 * This used to read `province === "QC"` and hand back a boolean named
 * `quebec`, which made Canada's regional exception the vocabulary every
 * other pack had to inherit.
 */
export function remittanceGroupRegionalCalendar(
  provinces: readonly string[],
  regionalCalendars: Readonly<Record<string, string>>,
): string | null {
  const [first, ...rest] = provinces;
  if (first === undefined) return null;
  if (!rest.every((province) => province === first)) return null;
  return regionalCalendars[first] ?? null;
}

/**
 * The regional-calendar declaration for a filing account's country, or `{}`
 * when the country is not one this deployment has a pack for. An unknown
 * country declares nothing rather than borrowing another pack's regions.
 */
export function remittanceRegionalCalendarsFor(
  country: string | null,
): Readonly<Record<string, string>> {
  if (!country) return {};
  return PAYROLL_COUNTRY_PACKS[country]?.remittanceRegionalCalendars ?? {};
}

/**
 * Fold component totals into one group per (destination vendor, filing
 * account). Pure, so the grouping rule that keeps one program account's
 * withholding out of another's PD7A is verifiable without a database.
 */
export function groupRemittanceRows(input: {
  rows: RemittanceRow[];
  contextByAccount: Map<string, { gross: string; employees: number }>;
  filingAccounts: Map<string, PayrollFilingAccount>;
  resolveParty: (row: RemittanceRow) => string | null;
  resolveAccount: (row: RemittanceRow) => string | null;
  /**
   * The vendor settings key the row resolved through, or null for
   * per-component destinations. Optional so existing callers keep their
   * shape; absent means no provenance, and no group carries a schedule key.
   */
  resolveVendorKey?: (row: RemittanceRow) => string | null;
  /**
   * The org's subsidiaries for slice labelling. Optional so existing callers
   * keep their shape; absent means slices carry the stub currency and a null
   * name, and the bill creator — which always resolves authoritatively
   * inside its own transaction — refuses what it cannot stamp.
   */
  subsidiaries?: Map<string, { name: string | null; currency: string | null }>;
  /**
   * The org-base currency the caller translated consolidated amounts into
   * (the mixed-currency scope). Present means every group states this
   * currency with `translated` set; absent means each group states its rows'
   * single native currency. Optional so existing callers keep their shape;
   * absent means native, never translated.
   */
  presentationCurrency?: string;
}): Map<string, RemittanceGroup> {
  const groups = new Map<string, RemittanceGroup>();
  const provincesByGroup = new Map<string, Set<string>>();
  // Distinct stub currencies behind each group, for the consolidated stated
  // currency of an untranslated (single-currency) scope.
  const currenciesByGroup = new Map<string, Set<string>>();
  // The pack country stamped on the group's own component rows — the same
  // country-first resolution the vendor declarations use.
  const countryByGroup = new Map<string, string>();
  const vendorKeysByGroup = new Map<string, Set<string>>();
  const slicesByGroup = new Map<string, Map<string, {
    components: RemittanceComponentLine[]; total: string; currencies: Set<string>;
  }>>();
  for (const row of input.rows) {
    if (cmp(row.amount, "0") === 0) continue;
    const partyId = input.resolveParty(row);
    const key = groupKey(partyId, row.filing_account_id);
    const runContext = input.contextByAccount.get(row.filing_account_id ?? "");
    const group = groups.get(key) ?? {
      partyId, partyName: null,
      filingAccount: filingAccountRef(row.filing_account_id, input.filingAccounts),
      hasUnknownFilingAccount: false,
      hasEntitylessAccruals: false,
      vendorKeys: [],
      schedule: null,
      provinces: [],
      regionalCalendar: null,
      components: [], total: "0",
      // The stated currency resolves after the fold (below): the caller's
      // presentation currency when translated, else the rows' single native
      // currency. The placeholder is never observed — every group has a row.
      currency: "",
      translated: false,
      slices: [],
      grossPayroll: runContext?.gross ?? "0",
      employeeCount: runContext?.employees ?? 0,
      existingBills: [],
    };
    group.hasUnknownFilingAccount = group.hasUnknownFilingAccount || row.filingUnknown;
    // Rows arrive per (component, province, historical liability account).
    // Provinces that resolve to the SAME destination fold back together, but
    // the fold NEVER merges two historical liability accounts: each account
    // keeps its own line (labelled component + account) so the bill debits
    // the account that was credited, and one account is never over-cleared
    // while another stays payable.
    const rowAccount = input.resolveAccount(row);
    const existing = group.components.find(
      (component) => component.componentId === row.component_id
        && component.kind === row.kind
        && component.liabilityAccountId === rowAccount,
    );
    if (existing) {
      existing.amount = add(existing.amount, row.amount);
    } else {
      group.components.push({
        componentId: row.component_id, code: row.code, name: row.name, kind: row.kind,
        systemKey: row.system_key, liabilityAccountId: rowAccount,
        accountLabel: null, amount: row.amount,
        // Resolved after the fold with the group's stated currency: in a
        // translated scope the consolidated amount is presentation units.
        currency: "",
      });
    }
    group.total = add(group.total, row.amount);
    // The WRITE path folds the same rows a second time, by legal entity, in
    // native units. Rows with no source entity stay consolidated only: no
    // bill can be stamped without an entity, so the creator refuses the
    // group while `hasEntitylessAccruals` is set.
    if (row.subsidiary_id == null) {
      group.hasEntitylessAccruals = true;
    } else {
      const slices = slicesByGroup.get(key) ?? new Map<string, {
        components: RemittanceComponentLine[]; total: string; currencies: Set<string>;
      }>();
      const slice = slices.get(row.subsidiary_id) ?? {
        components: [], total: "0", currencies: new Set<string>(),
      };
      // The entity slice folds by the same identity: one line per
      // (component, historical liability account), so the bill writes one
      // document line per credited account and each clears exactly.
      const sliceExisting = slice.components.find(
        (component) => component.componentId === row.component_id
          && component.kind === row.kind
          && component.liabilityAccountId === rowAccount,
      );
      if (sliceExisting) {
        sliceExisting.amount = add(sliceExisting.amount, row.sliceAmount);
      } else {
        slice.components.push({
          componentId: row.component_id, code: row.code, name: row.name, kind: row.kind,
          systemKey: row.system_key, liabilityAccountId: rowAccount,
          accountLabel: null, amount: row.sliceAmount,
          // Slice currency resolves after the fold, beside the slice total.
          currency: "",
        });
      }
      slice.total = add(slice.total, row.sliceAmount);
      slice.currencies.add(row.currency);
      slices.set(row.subsidiary_id, slice);
      slicesByGroup.set(key, slices);
    }
    groups.set(key, group);
    const provinces = provincesByGroup.get(key) ?? new Set<string>();
    provinces.add(row.province);
    provincesByGroup.set(key, provinces);
    const rowCurrencies = currenciesByGroup.get(key) ?? new Set<string>();
    rowCurrencies.add(row.currency);
    currenciesByGroup.set(key, rowCurrencies);
    if (row.country && !countryByGroup.has(key)) countryByGroup.set(key, row.country);
    const vendorKey = input.resolveVendorKey?.(row);
    if (vendorKey) {
      const vendorKeys = vendorKeysByGroup.get(key) ?? new Set<string>();
      vendorKeys.add(vendorKey);
      vendorKeysByGroup.set(key, vendorKeys);
    }
  }
  for (const [key, group] of groups) {
    // The consolidated stated currency: the caller's presentation currency
    // when the scope was translated into the org's base, else the rows'
    // single native currency. Several native currencies with no presentation
    // (an org with no base currency) state nothing rather than guess.
    if (input.presentationCurrency != null) {
      group.currency = input.presentationCurrency;
      group.translated = true;
    } else {
      const native = [...(currenciesByGroup.get(key) ?? [])].sort();
      group.currency = native.length === 1 ? native[0]! : "";
      group.translated = false;
    }
    for (const component of group.components) component.currency = group.currency;
    group.provinces = [...(provincesByGroup.get(key) ?? [])].sort();
    // The declaring pack is the one stamped on the group's own component
    // rows. Rows naming no country declare no regions, so a group the pack
    // layer cannot place keeps the national calendar rather than borrowing
    // some other authority's regional exception.
    group.regionalCalendar = remittanceGroupRegionalCalendar(
      group.provinces,
      remittanceRegionalCalendarsFor(countryByGroup.get(key) ?? null),
    );
    group.vendorKeys = [...(vendorKeysByGroup.get(key) ?? [])].sort();
    group.slices = [...(slicesByGroup.get(key) ?? [])]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([subsidiaryId, slice]) => {
        const known = input.subsidiaries?.get(subsidiaryId);
        const native = [...slice.currencies].sort();
        // The entity's own base currency when known; otherwise the stubs'
        // single currency when they agree. The bill creator re-resolves
        // this authoritatively and refuses anything it cannot stamp.
        const currency = known?.currency ?? (native.length === 1 ? native[0]! : "");
        for (const component of slice.components) component.currency = currency;
        return {
          subsidiaryId,
          subsidiaryName: known?.name ?? null,
          currency,
          components: slice.components,
          total: slice.total,
          existingBills: [],
        };
      });
  }
  return groups;
}

/**
 * Bill memo naming the period and, for multi-account employers, the account.
 * A multi-entity group's per-slice bills additionally name the entity, so two
 * drafts for one period are distinguishable in AP; a single-slice group keeps
 * the historical memo byte-identical.
 */
function remittanceMemo(
  group: RemittanceGroup,
  from: string,
  to: string,
  entityName: string | null = null,
): string {
  const account = group.filingAccount.accountNumber
    ? ` · ${group.filingAccount.accountNumber}`
    : "";
  const entity = entityName ? ` · ${entityName}` : "";
  return `Payroll remittance ${from} – ${to}${account}${entity}`;
}

/**
 * The CRA public-holiday calendar a remittance deadline moves against.
 *
 * NOT the employer's calendar, and deliberately not tenant-overridable. The
 * CRA recognizes Easter Monday and the Civic Holiday, which no province's
 * employment standards act lists, and it excludes the Civic Holiday in Quebec
 * while recognizing Saint-Jean-Baptiste Day there. Letting an employer's own
 * closures push a federal deadline would be letting configuration create a
 * penalty; the pack's declaration is the whole input.
 *
 * Source: https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html
 */
function craCalendar(around: string, regionalCalendar: string | null): ReadonlySet<string> {
  return scheduleCalendar(around, regionalCalendar ?? "CA-CRA");
}

/**
 * The working-day calendar a declared destination schedule moves deadlines
 * against. The jurisdiction is the schedule's own declaration — a
 * `tax_administration` calendar, never an employment one — so the generic
 * layer executes any pack's schedule without naming it.
 */
function scheduleCalendar(around: string, jurisdiction: string): ReadonlySet<string> {
  const year = Number(around.slice(0, 4));
  return holidayDateSet(resolveObservedHolidays({
    jurisdiction,
    from: `${year - 1}-01-01`,
    to: `${year + 1}-12-31`,
  }));
}

/** The last day of the month `date` falls in. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return civilDateFromParts(y!, m!, daysInCivilMonth(y!, m!));
}

/** The `day`th of the month `offsetMonths` after the one `date` falls in. */
function dayOfMonth(date: string, offsetMonths: number, day: number): string {
  const [y, m] = date.split("-").map(Number);
  // Month overflow normalizes exactly like the Date.UTC idiom this replaces
  // (day 31 in a short month rolls into the next month); only the 0-99 →
  // 1900-1999 remap is gone.
  const total = (m! - 1) + offsetMonths;
  const targetYear = y! + Math.floor(total / 12);
  const targetMonth1 = (((total % 12) + 12) % 12) + 1;
  return civilDateFromParts(targetYear, targetMonth1, day);
}

export interface RemittanceDue {
  dueDate: string;
  /** The statutory rule applied, carried onto the bill so an operator can
   *  see WHY the date is what it is rather than trusting it. */
  rule: string;
}

/**
 * The CRA due date for a remittance period, for every remitter type.
 *
 * A remitter's deadline is a function of
 * `payroll_filing_accounts.remitter_type` and of where the period ends inside
 * the month. Each rule below is transcribed from the CRA's published
 * "When to remit (pay)" table, verified against canada.ca:
 *
 *   https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/
 *     payroll/remitting-source-deductions/how-when-remit-due-dates.html
 *
 * - QUARTERLY — "January 1 to March 31 … April 15; April 1 to June 30 …
 *   July 15; July 1 to September 30 … October 15; October 1 to December 31 …
 *   January 15": the 15th of the month following the end of the quarter the
 *   period falls in.
 * - REGULAR — remitting period is the calendar month; due "the 15th day of the
 *   next month".
 * - ACCELERATED THRESHOLD 1 — "1st to 15th of the month … 25th day of same
 *   month; 16th to end of the month … 10th day of the next month."
 * - ACCELERATED THRESHOLD 2 — four quarter-month periods, "1st to 7th … 3rd
 *   working day after the 7th; 8th to 14th … 3rd working day after the 14th;
 *   15th to 21st … 3rd working day after the 21st; 22nd to the last day … 3rd
 *   working day after the last day of the month."
 *
 * And the shift, from the same page: "If your due date falls on a Saturday, a
 * Sunday, or a public holiday recognized by the CRA, your remittance is on
 * time if the CRA receives it on the next business day." That applies to the
 * three fixed-date schedules. Threshold 2 needs no shift — counting three
 * WORKING days necessarily lands on a working day, which is exactly why this
 * function could not exist before there was a working-day calendar.
 *
 * The penalty for getting this wrong is 3% to 10% of the remittance (20% for a
 * repeat in the same calendar year), which is why every rule above is quoted
 * rather than remembered, and why the calendar is the CRA's own list rather
 * than an employer's.
 */
export function remittanceDueDateExplained(
  periodTo: string,
  remitterType: PayrollFilingAccount["remitterType"] | null,
  options: { regionalCalendar?: string | null } = {},
): RemittanceDue {
  const date = periodTo.slice(0, 10);
  const holidays = craCalendar(date, options.regionalCalendar ?? null);
  const day = Number(date.slice(8, 10));
  // No filing account configured = the CRA's default registration for a new
  // employer, which is a regular remitter. Previous single-account behaviour,
  // preserved exactly.
  const remitter = remitterType ?? "regular";

  switch (remitter) {
    case "regular":
      return {
        dueDate: nextBusinessDay(dayOfMonth(date, 1, 15), holidays),
        rule: "regular remitter — the 15th of the month following the month of the pay date",
      };
    case "quarterly": {
      // The quarter the period ends in; its following month's 15th.
      const month = Number(date.slice(5, 7));
      const monthsToQuarterEnd = 2 - ((month - 1) % 3);
      return {
        dueDate: nextBusinessDay(dayOfMonth(date, monthsToQuarterEnd + 1, 15), holidays),
        rule: "quarterly remitter — the 15th of the month following the end of the quarter",
      };
    }
    case "accelerated_1":
      return day <= 15
        ? {
            dueDate: nextBusinessDay(dayOfMonth(date, 0, 25), holidays),
            rule: "accelerated threshold 1 — remuneration paid the 1st to the 15th, "
              + "due the 25th of the same month",
          }
        : {
            dueDate: nextBusinessDay(dayOfMonth(date, 1, 10), holidays),
            rule: "accelerated threshold 1 — remuneration paid the 16th to month end, "
              + "due the 10th of the following month",
          };
    case "accelerated_2": {
      // Three WORKING days after the end of the quarter-month period the
      // remittance period closes in. addBusinessDays never counts the day it
      // starts from, so a period ending on the 7th counts the 8th onward.
      const [periodEnd, label] = day <= 7 ? [dayOfMonth(date, 0, 7), "the 1st to the 7th"]
        : day <= 14 ? [dayOfMonth(date, 0, 14), "the 8th to the 14th"]
        : day <= 21 ? [dayOfMonth(date, 0, 21), "the 15th to the 21st"]
        : [monthEnd(date), "the 22nd to the last day of the month"];
      return {
        dueDate: addBusinessDays(periodEnd!, 3, holidays),
        rule: `accelerated threshold 2 — remuneration paid ${label}, due the 3rd working day `
          + "after the end of that period",
      };
    }
  }
}

/**
 * The due date alone. Never null any more: the working-day calendar this used
 * to be missing is `engine/src/payroll/holidays.ts`, and all four CRA
 * schedules are now computed rather than refused.
 */
export function remittanceDueDate(
  periodTo: string,
  remitterType: PayrollFilingAccount["remitterType"] | null,
  options: { regionalCalendar?: string | null } = {},
): string {
  return remittanceDueDateExplained(periodTo, remitterType, options).dueDate;
}

/**
 * Which frequency of a declared destination schedule governs: the org's
 * configured value under the schedule's frequency settings key, or the
 * schedule's own default when unconfigured or naming nothing declared.
 * Falling back rather than throwing is deliberate — an unconfigured schedule
 * still dates the bill, and readiness (not the bill path) nags the org to
 * confirm the frequency against the agency's notice.
 */
export function scheduledRemittanceFrequency(
  schedule: PayrollRemittanceSchedule,
  payrollSettings: Record<string, unknown>,
): { frequency: string; source: "configured" | "default" } {
  const configured = payrollSettings[schedule.frequencySettingsKey];
  if (typeof configured === "string" && remittanceFrequencyBand(schedule, configured)) {
    return { frequency: configured, source: "configured" };
  }
  return { frequency: schedule.defaultFrequency, source: "default" };
}

/**
 * The due date for a remittance period under a pack-declared destination
 * schedule (Revenu Québec's, today) — the counterpart to
 * `remittanceDueDateExplained`, which remains the legacy path for
 * destinations no pack declares. The rule shapes are the schedule's data;
 * this function only executes them against the schedule's own calendar, so a
 * second agency's timetable is a second declaration, never a branch.
 *
 * An unknown frequency falls back to the schedule default rather than
 * throwing: the caller already reports whether the frequency was configured,
 * and a bill must date itself even when configuration drifted.
 */
export function scheduledRemittanceDueDateExplained(
  schedule: PayrollRemittanceSchedule,
  frequency: string,
  periodTo: string,
): RemittanceDue {
  // The default is validated into the declaration (see allRemittanceSchedules),
  // so this fallback cannot itself miss.
  const band: PayrollRemittanceFrequencyBand =
    remittanceFrequencyBand(schedule, frequency)
    ?? remittanceFrequencyBand(schedule, schedule.defaultFrequency)!;
  const date = periodTo.slice(0, 10);
  const holidays = scheduleCalendar(date, schedule.calendar);
  const day = Number(date.slice(8, 10));
  switch (band.due.kind) {
    case "month_day":
      return {
        dueDate: nextBusinessDay(
          dayOfMonth(date, band.due.monthsAfterPeriodMonth, band.due.day), holidays,
        ),
        rule: band.rule,
      };
    case "quarter_day": {
      const month = Number(date.slice(5, 7));
      const monthsToQuarterEnd = 2 - ((month - 1) % 3);
      return {
        dueDate: nextBusinessDay(
          dayOfMonth(date, monthsToQuarterEnd + band.due.monthsAfterQuarterEnd, band.due.day),
          holidays,
        ),
        rule: band.rule,
      };
    }
    case "split_month":
      return day <= band.due.cutoffDay
        ? {
            dueDate: nextBusinessDay(
              dayOfMonth(date, band.due.firstDueMonthOffset, band.due.firstDueDay), holidays,
            ),
            rule: band.rule,
          }
        : {
            dueDate: nextBusinessDay(
              dayOfMonth(date, band.due.secondDueMonthOffset, band.due.secondDueDay), holidays,
            ),
            rule: band.ruleSecondHalf ?? band.rule,
          };
    case "quarter_month_working_days": {
      // The quarter-month the period falls in ends on the 7th, 14th, 21st or
      // month end; the deadline counts workingDays WORKING days from there on
      // the schedule's own calendar. Counting working days lands on a working
      // day by construction, so no weekend/holiday shift applies.
      const periodEnd = day <= 7 ? dayOfMonth(date, 0, 7)
        : day <= 14 ? dayOfMonth(date, 0, 14)
        : day <= 21 ? dayOfMonth(date, 0, 21)
        : monthEnd(date);
      return {
        dueDate: addBusinessDays(periodEnd, band.due.workingDays, holidays),
        rule: band.rule,
      };
    }
  }
}

/**
 * The schedule governing one remittance group for one period end — the
 * destination-keyed counterpart to the CRA-function path. Resolution order:
 *
 * 1. Provenance: a row that arrived through a scheduled destination's vendor
 *    key is governed by that schedule, even when the org left the vendor
 *    unconfigured (an unassigned RQ destination is still an RQ destination).
 *    A declared schedule always beats the legacy path, so a misconfigured org
 *    pointing two keys at one party still gets the declared date.
 * 2. Party: an `external` component pointed at a scheduled destination's
 *    configured vendor (Québec income tax remitted to the RQ vendor).
 *
 * Null when no pack declares the destination — the caller keeps the legacy
 * CRA-function behaviour. Pure over an explicit schedule list, so the
 * precedence is verifiable without a database.
 */
export function scheduleForRemittanceGroup(input: {
  vendorKeys: readonly string[];
  partyId: string | null;
  periodTo: string;
  payrollSettings: Record<string, unknown>;
  schedules?: readonly PayrollRemittanceSchedule[];
}): RemittanceGroupSchedule | null {
  const schedules = input.schedules ?? allRemittanceSchedules();
  const dated = input.vendorKeys
    .map((vendorSettingsKey) => ({
      vendorSettingsKey,
      schedule: remittanceScheduleInForce(vendorSettingsKey, input.periodTo, schedules),
    }))
    .find((candidate) => candidate.schedule);
  const byParty = (): { vendorSettingsKey: string; schedule: PayrollRemittanceSchedule } | null => {
    if (!input.partyId) return null;
    for (const schedule of schedules) {
      const configured = input.payrollSettings[schedule.vendorSettingsKey];
      if (typeof configured !== "string" || !configured || configured !== input.partyId) continue;
      const inForce = remittanceScheduleInForce(schedule.vendorSettingsKey, input.periodTo, schedules);
      if (inForce) return { vendorSettingsKey: schedule.vendorSettingsKey, schedule: inForce };
    }
    return null;
  };
  const resolved = dated ?? byParty();
  if (!resolved || !resolved.schedule) return null;
  const { frequency, source } = scheduledRemittanceFrequency(resolved.schedule, input.payrollSettings);
  const due = scheduledRemittanceDueDateExplained(resolved.schedule, frequency, input.periodTo);
  return {
    vendorSettingsKey: resolved.vendorSettingsKey,
    authority: resolved.schedule.authority,
    frequency,
    frequencySource: source,
    dueDate: due.dueDate,
    rule: due.rule,
  };
}

/**
 * Advisory: does last year's measured monthly average for a scheduled
 * destination sit in a different band than the frequency the bills date at?
 *
 * The pack's average-monthly bands are what the agency assigns frequencies
 * from, so a configured frequency two bands away from the measured average
 * is worth an operator's look — a large employer left on the monthly default
 * remits late all year. Advisory ONLY: it never throws (an org mid-setup can
 * hold committed payroll the summary refuses to read), and it never changes a
 * bill — the configured-or-default frequency dates, full stop.
 *
 * The average is the destination's committed prior-year total over 12
 * calendar months, stated in the message so the operator can judge it (a
 * mid-year adopter's partial year reads low by construction). Returns the
 * warning sentence, or null when there is no prior-year history for the
 * destination or the bands agree.
 */
export async function scheduledFrequencyAdvisory(
  orgId: string,
  schedule: PayrollRemittanceSchedule,
  vendorPartyId: string,
  payrollSettings: Record<string, unknown>,
  year: number,
  executor: RemittanceExecutor = db,
): Promise<string | null> {
  let groups: RemittanceGroup[];
  try {
    groups = await payrollRemittanceSummary(
      orgId,
      { from: `${year}-01-01`, to: `${year}-12-31` },
      undefined,
      executor,
    );
  } catch {
    return null;
  }
  const group = groups.find((candidate) => candidate.partyId === vendorPartyId);
  if (!group || cmp(group.total, "0") === 0) return null;
  const average = div(group.total, "12");
  const { frequency } = scheduledRemittanceFrequency(schedule, payrollSettings);
  const measured = remittanceBandForAverage(schedule, average);
  if (!measured || measured.frequency === frequency) return null;
  return `${schedule.authority} remittances averaged $${formatMoney(average, 2)}/month across ${year} — ` +
    `the ${measured.label.toLowerCase()} band — but bills date at the ${frequency.replaceAll("_", " ")} ` +
    `frequency; confirm it against your ${schedule.authority} notice in Setup → Payroll`;
}

/**
 * The identity of one remittance bill: destination vendor × period window ×
 * filing account × legal entity. One bill per key — the key is both the
 * advisory lock's scope and the structured marker searched back before a
 * second bill is minted. The entity segment is what keeps two concurrent
 * creators for different slices of one multi-entity group from minting the
 * same slice twice while letting each slice proceed independently.
 */
export interface RemittanceBillKey {
  partyId: string;
  from: string;
  to: string;
  filingAccountId: string | null;
  subsidiaryId?: string | null;
}

/** The transaction advisory lock that serializes creation for one key. */
export function remittanceBillLockKey(orgId: string, key: RemittanceBillKey): string {
  return `payroll-remittance-bill:${orgId}:${key.partyId}:${key.from}:${key.to}:${key.filingAccountId ?? ""}:${key.subsidiaryId ?? ""}`;
}

/**
 * The fence shared by every period for one remittance destination, filing
 * account and legal entity. Periods are deliberately not part of this key:
 * two overlapping windows must serialize before the overlap check can decide
 * which one wins. The entity IS part of this key: without it, two concurrent
 * creators each raising a different slice of the same group would serialize
 * on one lock and — worse — neither would see the other's marker.
 */
export function remittanceFenceLockKey(
  orgId: string,
  key: Pick<RemittanceBillKey, "partyId" | "filingAccountId"> & Pick<RemittanceBillKey, "subsidiaryId">,
): string {
  return `payroll-remittance-fence:${orgId}:${key.partyId}:${key.filingAccountId ?? ""}:${key.subsidiaryId ?? ""}`;
}

/**
 * The duplicate refusal, or null when the coast is clear.
 *
 * Pure, so the rule — one bill per uncovered remainder, and no second bill
 * for lines a live bill already consumed — is verifiable without a database.
 * An exact re-run with nothing new left to bill is refused naming the first
 * bill; a voided bill frees its lines deliberately, so the correction path
 * stays void-then-recreate, never two live drafts debiting the same
 * liabilities.
 */
export function duplicateRemittanceMessage(
  existing: { documentNumber: string | null } | undefined,
): string | null {
  if (!existing) return null;
  return `a remittance bill for this vendor, period and filing account already exists `
    + `(${existing.documentNumber ?? "unnumbered"}) — one bill per remittance; `
    + "post, edit or void that draft instead of raising a second";
}

/** Refusal for a new period that would consume liabilities already covered by
 * another live remittance bill. The exact-window case keeps the established
 * idempotency message; this names the two windows so a controller can choose
 * a non-overlapping correction period without guessing. */
export function overlappingRemittanceMessage(
  existing: { documentNumber: string | null; from: string; to: string } | undefined,
): string | null {
  if (!existing) return null;
  return `this remittance period overlaps ${existing.from} – ${existing.to}`
    + ` for the same vendor and filing account (${existing.documentNumber ?? "unnumbered"})`;
}

/**
 * Which vendor_bill series numbers the remittance bill: the org's EXISTING
 * one, never a parallel series.
 *
 * The bill is a vendor_bill like any other, and documents_org_kind_number
 * makes document numbers unique per (org, kind, number) — so allocating from
 * a private org-level series hardcoded 'BILL-' forks the org's vendor-bill
 * numbering and collides outright once the org's real series emits the same
 * prefix and number. Preference follows the AP path's own rule
 * (web/lib/bills.ts): the billed entity's series when the org scopes its
 * vendor bills per subsidiary, else the org-wide series. Null when neither
 * exists, and the caller seeds 'BILL-' exactly as it always did.
 */
export function pickRemittanceSequence(
  rows: readonly { prefix: string; subsidiaryId: string | null }[],
  billedSubsidiaryId: string,
): { prefix: string; subsidiaryId: string | null } | null {
  return rows.find((row) => row.subsidiaryId === billedSubsidiaryId)
    ?? rows.find((row) => row.subsidiaryId === null)
    ?? null;
}

/**
 * Which entity slice of a remittance group a bill is raised for. A caller
 * naming `subsidiaryId` bills exactly that slice; otherwise the group must
 * hold exactly one slice — a group spanning several entities never bills as
 * one document (that would re-merge what double-entry keeps apart), it
 * splits: one call per slice. Pure, so the split-or-refuse rule is verifiable
 * without a database.
 */
export function pickRemittanceSlice(
  group: RemittanceGroup,
  subsidiaryId: string | null,
): RemittanceEntitySlice {
  if (subsidiaryId != null) {
    const slice = group.slices.find((candidate) => candidate.subsidiaryId === subsidiaryId);
    if (!slice) throw new PayrollError("nothing to remit to this vendor for the period");
    return slice;
  }
  if (group.slices.length === 1) return group.slices[0]!;
  if (group.slices.length === 0) {
    throw new PayrollError(
      "this remittance group includes payroll with no legal entity — attribute its pay runs "
      + "to a subsidiary before remitting",
    );
  }
  throw new PayrollError(
    `this remittance spans ${group.slices.length} legal entities `
    + `(${group.slices.map((slice) => `${slice.subsidiaryName ?? slice.subsidiaryId}: ${slice.total} ${slice.currency}`).join("; ")}) `
    + "— raise one bill per entity",
  );
}

/**
 * Materialize one destination's remittance as a draft vendor bill debiting
 * the liability accounts. Fails closed on unassigned accounts. The bill then
 * posts DR liabilities / CR AP and is paid like any other payable.
 *
 * `filingAccountId` selects the payroll program/EIN account being remitted;
 * omit it (or pass null) for the unassigned bucket of a single-account org.
 * One bill per account keeps each PD7A remittance separately traceable.
 *
 * `subsidiaryId` selects the legal entity being remitted. A bill is a
 * single-entity AP document: it is stamped with the entity whose books
 * credited the accruals, in that entity's currency, and debits that entity's
 * liabilities so they clear. Omit it for a single-entity group; a group
 * spanning several entities splits — one call per slice — and an omitted
 * `subsidiaryId` there is refused naming the entities.
 *
 * Creating is IDEMPOTENT per (destination, period, filing account, entity)
 * AND consumed line: a transaction-scoped advisory lock serializes
 * concurrent creators (a double-click, a retried request), per-accrual
 * coverage records exactly which lines each bill consumed, and a later
 * same-window run bills only the unbilled remainder. An exact re-run with
 * nothing left to bill is refused by name rather than minted twice, and an
 * intersecting live bill with no coverage rows (an unreconciled legacy bill)
 * fails closed rather than risk a double bill.
 */
export async function createRemittanceBill(
  orgId: string,
  actorId: string,
  input: {
    partyId: string;
    from: string;
    to: string;
    filingAccountId?: string | null;
    subsidiaryId?: string | null;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  },
): Promise<{ documentId: string; documentNumber: string }> {
  const filingAccountId = input.filingAccountId ?? null;
  const periodProblem = remittancePeriodProblem(input.from, input.to);
  if (periodProblem) throw new PayrollError(periodProblem);

  // Auto mode must discover WHICH entity before it can fence it. This
  // preflight read may go stale — the canonical summary inside the
  // transaction re-resolves and governs — but it can only resolve to a
  // refusal or to a slice the canonical pass re-checks.
  let entityId = input.subsidiaryId ?? null;
  if (entityId == null) {
    const preflight = await payrollRemittanceSummary(
      orgId,
      { from: input.from, to: input.to },
      input.allowedSubsidiaryIds,
    );
    const found = preflight.find(
      (g) => g.partyId === input.partyId && g.filingAccount.id === filingAccountId,
    );
    if (!found) throw new PayrollError("nothing to remit to this vendor for the period");
    if (found.hasUnknownFilingAccount) {
      throw new PayrollError(
        "this remittance group includes payroll with an unknown historical filing account — reconcile its original payroll evidence before remitting",
      );
    }
    if (found.hasEntitylessAccruals) {
      throw new PayrollError(
        "this remittance group includes payroll with no legal entity — attribute its pay runs to an active subsidiary before remitting",
      );
    }
    entityId = pickRemittanceSlice(found, null).subsidiaryId;
  }

  return await db.transaction(async (tx) => {
    // Serialize every period for this destination, filing account AND entity
    // BEFORE reading the accruals. The explicit READ COMMITTED mode is
    // intentional: PostgreSQL takes a fresh statement snapshot after a
    // blocked advisory lock returns, so accruals committed while this creator
    // waited are in the canonical summary below. Two creators for different
    // slices hold different locks and proceed independently; two for the same
    // slice serialize, and the second meets the first's marker.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${remittanceFenceLockKey(orgId, {
        partyId: input.partyId, filingAccountId, subsidiaryId: entityId,
      })}, 0))
    `);

    const vendor = (await tx.execute<{ party_id: string | null; subsidiary_id: string | null }>(sql`
      select p.id as party_id, p.subsidiary_id
        from vendor_roles v
        left join parties p on p.id = v.party_id and p.org_id = v.org_id
       where v.org_id = ${orgId} and v.party_id = ${input.partyId} and v.is_active
    `));
    if (!vendor.rows.length) throw new PayrollError("the remittance destination must be an active vendor");
    if (
      input.allowedSubsidiaryIds != null
      && (!(vendor.rows[0]!.party_id)
        || !payrollSubsidiaryInScope(
          input.allowedSubsidiaryIds,
          vendor.rows[0]!.subsidiary_id ?? entityId,
        ))
    ) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, entityId)) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }

    // The registration this run is filed under — metadata ABOUT the
    // obligation, never the bill's entity. When it names another entity, the
    // run was filed under the wrong registration: refuse, naming both.
    const filing = filingAccountId
      ? (await tx.execute<{
        subsidiary_id: string | null; account_number: string | null; name: string | null;
      }>(sql`
        select subsidiary_id, account_number, name from payroll_filing_accounts
         where org_id = ${orgId} and id = ${filingAccountId} and is_active
      `)).rows[0] ?? null
      : null;
    if (filingAccountId && !filing) throw new PayrollError("nothing to remit to this vendor for the period");
    if (
      input.allowedSubsidiaryIds != null
      && filing
      && !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, filing.subsidiary_id ?? entityId)
    ) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }

    // Recompute from this transaction's snapshot only after the entity fence
    // is held. A pay run committed after a caller's preflight summary is
    // therefore included in this canonical bill, rather than stranded behind
    // an exact-period duplicate marker.
    const groups = await payrollRemittanceSummary(
      orgId,
      { from: input.from, to: input.to },
      input.allowedSubsidiaryIds,
      tx,
    );
    const group = groups.find(
      (g) => g.partyId === input.partyId && g.filingAccount.id === filingAccountId,
    );
    if (!group) throw new PayrollError("nothing to remit to this vendor for the period");
    // Fail closed for this run's boxes only: a group carrying unattributed
    // legacy accruals must not become a remittance bill under any account
    // until those stubs are reconciled. Every other group still bills.
    if (group.hasUnknownFilingAccount) {
      throw new PayrollError(
        "this remittance group includes payroll with an unknown historical filing account — reconcile its original payroll evidence before remitting",
      );
    }
    // A bill is stamped with the entity whose books credited the accruals.
    // Entityless rows stay in the consolidated group only: billing the
    // attributed slices while unattributed money sits in the same group
    // would remit a partial period as if it were whole.
    if (group.hasEntitylessAccruals) {
      throw new PayrollError(
        "this remittance group includes payroll with no legal entity — attribute its pay runs to an active subsidiary before remitting",
      );
    }
    const slice = pickRemittanceSlice(group, input.subsidiaryId ?? null);
    if (slice.subsidiaryId !== entityId) {
      // The group re-sliced between preflight and fence: another entity's
      // payroll committed (or voided) while this creator waited. Refuse
      // rather than bill a slice the caller never saw.
      throw new PayrollError("nothing to remit to this vendor for the period");
    }
    // Liability-account assignment is checked against the lines this bill
    // will actually consume (below): a line an earlier bill already covered
    // was assigned then, and only the remainder can refuse now.

    // The AUTHORITATIVE entity resolution. The summary labelled this slice
    // from its own snapshot; the bill stamps what the subsidiaries table says
    // in this transaction — an inactive entity, a missing currency, or
    // accruals that do not belong to one currency cannot become a bill.
    const entity = (await tx.execute<{ id: string; name: string | null; base_currency: string | null }>(sql`
      select id, name, base_currency from subsidiaries
       where org_id = ${orgId} and id = ${entityId} and is_active
    `)).rows[0] ?? null;
    if (!entity) {
      throw new PayrollError(
        `cannot remit this payroll: its subsidiary is missing or inactive — attribute its pay runs to an active subsidiary before remitting`,
      );
    }
    if (!entity.base_currency) {
      throw new PayrollError(
        `cannot remit ${entity.name ?? "this entity"}'s payroll: it has no base currency — set one on the subsidiary before remitting`,
      );
    }
    const stubCurrencies = await sliceStubCurrencies(tx, orgId, {
      from: input.from, to: input.to, partyId: input.partyId, filingAccountId, entityId,
    });
    if (stubCurrencies.length !== 1 || stubCurrencies[0] !== entity.base_currency) {
      throw new PayrollError(
        `cannot remit ${entity.name ?? "this entity"}'s payroll in ${entity.base_currency}: `
        + `its accruals are stated in ${stubCurrencies.length ? stubCurrencies.join(", ") : "no currency"} `
        + "— reconcile the pay runs before remitting",
      );
    }

    // Payroll filed under another entity's registration is a compliance fact,
    // not a preference. The filing account's entity must equal the accruals'
    // entity; when it does not, the message names both entities and the runs
    // behind the slice so the operator can act without opening a console.
    if (filing && filing.subsidiary_id != null && filing.subsidiary_id !== entityId) {
      const accountEntity = (await tx.execute<{ name: string | null }>(sql`
        select name from subsidiaries where org_id = ${orgId} and id = ${filing.subsidiary_id}
      `)).rows[0]?.name ?? null;
      const runs = (await tx.execute<{ document_number: string }>(sql`
        select distinct d.document_number
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where s.org_id = ${orgId} and s.pay_date between ${input.from} and ${input.to}
           and d.subsidiary_id = ${entityId}
           and s.filing_account_id is not distinct from ${filingAccountId}
         order by d.document_number
      `)).rows.map((r) => r.document_number);
      throw new PayrollError(
        `cannot remit ${entity.name ?? "this entity"}'s payroll under filing account `
        + `${filing.account_number ?? filing.name ?? filingAccountId} `
        + `(registered to ${accountEntity ?? "another entity"}): `
        + `pay run${runs.length === 1 ? "" : "s"} ${runs.length ? runs.join(", ") : "unknown"} `
        + `accrued on ${entity.name ?? "this entity"}'s books — remit under `
        + `${entity.name ?? "this entity"}'s registration instead`,
      );
    }

    // The structured marker written below is the bill's identity. Search live
    // markers for this destination/account/entity and reject any intersecting
    // date window, not only exact from/to equality. A legacy bill with no
    // entity marker covered the consolidated group, so it fails closed for
    // every slice rather than risking a double remittance — unless coverage
    // proves exactly which lines it consumed (below), in which case a later
    // same-window bill covers only the unbilled remainder.
    const overlap = (await tx.execute<{
      id: string; document_number: string | null; subsidiary_id: string | null; from: string; to: string;
    }>(sql`
      select id::text as id, document_number, subsidiary_id,
             custom->'payrollRemittance'->>'from' as from,
             custom->'payrollRemittance'->>'to' as to
        from documents
       where org_id = ${orgId} and kind = 'vendor_bill' and status <> 'voided'
         and custom->'payrollRemittance'->>'partyId' = ${input.partyId}
         and custom->'payrollRemittance'->>'from' <= ${input.to}
         and custom->'payrollRemittance'->>'to' >= ${input.from}
         and (custom->'payrollRemittance'->>'filingAccountId') is not distinct from ${filingAccountId}
         and ((custom->'payrollRemittance'->>'subsidiaryId') is null
              or (custom->'payrollRemittance'->>'subsidiaryId') = ${entityId})
      order by custom->'payrollRemittance'->>'from', created_at
    `));
    const existing = overlap.rows[0];
    // Refuse by name over an intersecting live bill. The first bill whose
    // window matches exactly keeps the established idempotency message; any
    // other overlap names both windows so a controller can choose a
    // non-overlapping correction period without guessing.
    const refuseOverlapping = (found: NonNullable<typeof existing>): never => {
      // Keep the overlap fence org-wide: hiding a conflicting document must
      // never permit a duplicate liability bill. Its identifying metadata is
      // only available to actors who can read that document's legal entity.
      if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, found.subsidiary_id)) {
        throw new PayrollError("nothing to remit to this vendor for the period");
      }
      const exact = found.from === input.from && found.to === input.to;
      const refusal = exact
        ? duplicateRemittanceMessage({ documentNumber: found.document_number })
        : overlappingRemittanceMessage({
            documentNumber: found.document_number,
            from: found.from,
            to: found.to,
          });
      if (refusal) throw new PayrollError(refusal);
      throw new PayrollError("nothing to remit to this vendor for the period");
    };

    // Number off the org's EXISTING vendor_bill series — its prefix, padding
    // and current position — falling back to seeding the org-level 'BILL-'
    // series only when the org has no vendor_bill numbering at all. The
    // billed entity's own series wins, exactly like the AP path's rule.
    const sequences = (await tx.execute<{ prefix: string; subsidiary_id: string | null }>(sql`
      select prefix, subsidiary_id from number_sequences
       where org_id = ${orgId} and document_kind = 'vendor_bill'
         and (subsidiary_id = ${entityId} or subsidiary_id is null)
    `));
    const chosen = pickRemittanceSequence(
      sequences.rows.map((row) => ({ prefix: row.prefix, subsidiaryId: row.subsidiary_id })),
      entityId,
    );
    const seq = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'vendor_bill', ${chosen?.subsidiaryId ?? null}, ${chosen?.prefix ?? "BILL-"})
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${orgId}
      returning prefix, next_number, padding
    `));
    const number = `${seq.rows[0]!.prefix}${String(seq.rows[0]!.next_number).padStart(seq.rows[0]!.padding, "0")}`;

    // Per-accrual coverage (migration 0296): record exactly which committed
    // lines this bill consumed, resolved through the same resolver the
    // summary folds by — including region-scoped rows whose snapshot party
    // is not their resolved destination. The equality below is the insert's
    // own receipt: coverage that does not sum to the billed slice is a
    // failure, not a success.
    const creatorResolution = makeRemittanceDestinationResolver(await rawPayrollSettings(orgId, tx));
    const billed = (await remittanceScopeLines(tx, orgId, {
      from: input.from, to: input.to, filingAccountId, entityId,
    })).filter((line) =>
      !creatorResolution.isInternalAccrual(line)
      && creatorResolution.resolveDestination(line).partyId === input.partyId,
    );
    const billedTotal = sum(billed.map((line) => (line.kind === "credit" ? neg(line.amount) : line.amount)));
    const scopeTotal = sum(slice.components.map((c) => c.amount));
    if (cmp(billedTotal, scopeTotal) !== 0) {
      throw new PayrollError(
        "remittance bill coverage does not match the billed payroll — regenerate this bill",
      );
    }
    // Coverage-aware remainder: lines a live bill already consumed are never
    // billed twice. A later same-window run bills only its unbilled lines;
    // with nothing left unbilled the fence refusals above still apply, so an
    // exact re-run keeps the established duplicate message.
    const coveredLineIds = await coveredRemittanceStubLines(tx, orgId);
    const billable = billed.filter((line) => !coveredLineIds.has(line.lineId));
    if (billable.length === 0) {
      if (existing) refuseOverlapping(existing);
      throw new PayrollError("nothing to remit to this vendor for the period");
    }
    if (existing) {
      // An intersecting live bill with no coverage rows consumed an
      // unknowable set (a legacy bill the 0296 repair could not reconcile):
      // no remainder can be proven against its window, so fail closed.
      const blind = await remittanceBillsWithoutCoverage(
        tx,
        orgId,
        overlap.rows.map((bill) => bill.id),
      );
      if (blind.length > 0) refuseOverlapping(existing);
    }
    // Aggregate the remainder by the same (component, kind, liability
    // account) identity the summary folds by, in first-seen line order, so
    // the bill debits exactly the accounts its own lines credited.
    const entries: {
      componentId: string; kind: RemittanceScopeLine["kind"]; name: string;
      liabilityAccountId: string | null; amount: string;
    }[] = [];
    for (const line of billable) {
      const amount = line.kind === "credit" ? neg(line.amount) : line.amount;
      const found = entries.find((entry) =>
        entry.componentId === line.componentId
        && entry.kind === line.kind
        && entry.liabilityAccountId === line.liabilityAccountId,
      );
      if (found) found.amount = add(found.amount, amount);
      else {
        entries.push({
          componentId: line.componentId,
          kind: line.kind,
          name: line.componentName,
          liabilityAccountId: line.liabilityAccountId,
          amount,
        });
      }
    }
    const missing = entries.filter((entry) => !entry.liabilityAccountId);
    if (missing.length > 0) {
      throw new PayrollError(
        `no liability account for: ${missing.map((entry) => entry.name).join(", ")} — set it in Payroll setup → Accounts & posting`,
      );
    }
    const total = sum(entries.map((entry) => entry.amount));
    if (cmp(sum(billable.map((line) => (line.kind === "credit" ? neg(line.amount) : line.amount))), total) !== 0) {
      throw new PayrollError(
        "remittance bill coverage does not match the billed payroll — regenerate this bill",
      );
    }
    // The bill's due date comes from the DESTINATION's schedule when a pack
    // declares one (Revenu Québec's, today) — the filing account's CRA
    // remitter type is a registration with another agency and never applies
    // to a scheduled destination. Undeclared destinations keep the legacy
    // CRA-function behaviour.
    const dueDate = group.schedule?.dueDate
      ?? remittanceDueDate(input.to, group.filingAccount.remitterType, {
        regionalCalendar: group.regionalCalendar,
      });
    const doc = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date,
                             due_date, currency, status, memo, subtotal, tax_total, total, custom,
                             created_by, updated_by)
      values (${orgId}, 'vendor_bill', ${number}, ${input.partyId}, ${entityId}, ${input.to},
              ${dueDate},
              ${entity.base_currency}, 'draft',
              ${remittanceMemo(group, input.from, input.to, group.slices.length > 1 ? (entity.name ?? null) : null)}, ${total}, '0', ${total},
              ${JSON.stringify({
                payrollRemittance: {
                  partyId: input.partyId, from: input.from, to: input.to, filingAccountId,
                  subsidiaryId: entityId,
                  // The filing account's CRA registration, for operators
                  // reconciling the bill against the PD7A. It did NOT date
                  // this bill when a destination schedule governs — see
                  // `schedule`, which names what did.
                  remitterType: group.filingAccount.remitterType,
                  schedule: group.schedule
                    ? {
                        vendorSettingsKey: group.schedule.vendorSettingsKey,
                        authority: group.schedule.authority,
                        frequency: group.schedule.frequency,
                      }
                    : null,
                },
              })}::jsonb,
              ${actorId}, ${actorId})
      returning id
    `));
    const documentId = doc.rows[0]!.id;
    let lineNumber = 1;
    for (const entry of entries) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${entry.liabilityAccountId},
                ${`${entry.name} · ${input.from} – ${input.to}`}, 1, ${entry.amount},
                ${entry.amount}, ${actorId}, ${actorId})
      `);
    }
    // The remainder's own coverage rows: one per consumed line, never one per
    // bill. The row count below is the insert's receipt — a short write means
    // a later same-window bill would re-bill the missing line, so refuse.
    const covered = (await tx.execute<{ stub_line_id: string }>(sql`
      insert into payroll_remittance_coverage (org_id, bill_document_id, stub_line_id, amount, created_by)
      select ${orgId}, ${documentId}, cov.line_id, cov.line_amount::numeric, ${actorId}
        from unnest(${`{${billable.map((line) => line.lineId).join(",")}}`}::uuid[],
                    ${`{${billable.map((line) => line.amount).join(",")}}`}::text[]) as cov(line_id, line_amount)
      returning stub_line_id::text as stub_line_id
    `));
    if (covered.rows.length !== billable.length) {
      throw new PayrollError(
        "remittance bill coverage was not recorded — regenerate this bill",
      );
    }
    return { documentId, documentNumber: number };
  }, { isolationLevel: "read committed" });
}

/**
 * One committed accrual line in a bill's scope, with the fields destination
 * resolution reads. The bill creator resolves these in TypeScript through the
 * same resolver the summary folds by, so coverage records exactly the lines
 * the bill consumed — including region-scoped rows whose snapshot party is
 * not their resolved destination.
 */
export interface RemittanceScopeLine {
  lineId: string;
  kind: "deduction" | "employer_contribution" | "credit";
  /** Raw native amount (credits net at read time, as the summary nets). */
  amount: string;
  /** The stub line's commit-time destination snapshot (migration 0296). */
  snapshotPartyId: string | null;
  systemKey: string | null;
  country: string | null;
  province: string;
  /** Which component accrued this line — the bill aggregates remainder lines
   *  by the same (component, kind, liability account) identity the summary
   *  folds by, so an incremental bill debits exactly the accounts its own
   *  lines credited. */
  componentId: string;
  componentName: string;
  /** The historical liability account credited at commit. */
  liabilityAccountId: string | null;
}

/**
 * Every committed accrual line behind one (period, filing account, entity)
 * scope — the bill's coverage population. Destination resolution stays in
 * TypeScript (pack declarations cannot be re-derived in SQL); callers keep
 * the lines whose resolved destination is their vendor.
 */
export async function remittanceScopeLines(
  executor: RemittanceExecutor,
  orgId: string,
  key: { from: string; to: string; filingAccountId: string | null; entityId: string },
): Promise<RemittanceScopeLine[]> {
  const rows = (await executor.execute<{
    line_id: string; kind: "deduction" | "employer_contribution" | "credit";
    amount: string; snapshot_party_id: string | null;
    system_key: string | null; country: string | null; province: string;
    component_id: string; component_name: string; liability_account_id: string | null;
  }>(sql`
    select l.id::text as line_id, l.kind, l.amount::text as amount,
           l.remittance_party_id::text as snapshot_party_id,
           c.system_key, c.country, s.province,
           c.id::text as component_id, c.name as component_name,
           l.liability_account_id::text as liability_account_id
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where l.org_id = ${orgId} and s.pay_date between ${key.from} and ${key.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       and d.subsidiary_id = ${key.entityId}
       and s.filing_account_id is not distinct from ${key.filingAccountId}
     order by l.id
  `));
  return rows.rows.map((row) => ({
    lineId: row.line_id,
    kind: row.kind,
    amount: row.amount,
    snapshotPartyId: row.snapshot_party_id,
    systemKey: row.system_key,
    country: row.country,
    province: row.province,
    componentId: row.component_id,
    componentName: row.component_name,
    liabilityAccountId: row.liability_account_id,
  }));
}

/**
 * Every accrual line a live (non-voided) remittance bill has consumed, by
 * stub line id. Voiding a bill frees its lines: the void-then-recreate
 * correction path re-bills them, and the overlap fence treats a freed window
 * as open. A live bill with no coverage rows at all (a legacy bill the 0296
 * repair could not reconcile) covers an unknowable set, so callers fail
 * closed on it rather than guess a remainder.
 */
export async function coveredRemittanceStubLines(
  executor: RemittanceExecutor,
  orgId: string,
): Promise<Set<string>> {
  const rows = (await executor.execute<{ stub_line_id: string }>(sql`
    select cov.stub_line_id::text as stub_line_id
      from payroll_remittance_coverage cov
      join documents bill
        on bill.id = cov.bill_document_id and bill.org_id = cov.org_id
     where cov.org_id = ${orgId} and bill.status <> 'voided'
  `));
  return new Set(rows.rows.map((row) => row.stub_line_id));
}

/**
 * Which live (non-voided) intersecting bills carry no coverage rows. Such a
 * bill consumed an unknowable set of lines, so no remainder can be proven
 * against its window — the creator refuses rather than risk a double bill.
 */
export async function remittanceBillsWithoutCoverage(
  executor: RemittanceExecutor,
  orgId: string,
  billIds: readonly string[],
): Promise<string[]> {
  if (billIds.length === 0) return [];
  const rows = (await executor.execute<{ bill_document_id: string }>(sql`
    select distinct cov.bill_document_id::text as bill_document_id
      from payroll_remittance_coverage cov
     where cov.org_id = ${orgId}
       and cov.bill_document_id = any(${`{${billIds.join(",")}}`}::uuid[])
  `));
  const withCoverage = new Set(rows.rows.map((row) => row.bill_document_id));
  return billIds.filter((id) => !withCoverage.has(id));
}

/**
 * The distinct stub currencies behind one entity slice of one group — the
 * ground truth for whether the slice can be stamped in its entity's base
 * currency. Re-read in the creator's transaction, not trusted from a
 * preflight summary.
 */
async function sliceStubCurrencies(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  key: { from: string; to: string; partyId: string; filingAccountId: string | null; entityId: string },
): Promise<string[]> {
  // The destination half of the group key is deliberately absent: components
  // resolve destinations through pack declarations the SQL cannot re-derive,
  // and the slice's entity × filing account × period already identifies the
  // accruals the summary folded in. A second destination sharing the slice
  // would only ADD a currency, failing safer.
  const rows = (await tx.execute<{ currency: string }>(sql`
    select distinct s.currency_code as currency
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where l.org_id = ${orgId} and s.pay_date between ${key.from} and ${key.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       and d.subsidiary_id = ${key.entityId}
       and s.filing_account_id is not distinct from ${key.filingAccountId}
  `));
  return rows.rows.map((r) => r.currency).sort();
}
