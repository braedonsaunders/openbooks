import { civilDateFromParts, endOfMonth } from "../platform/business-date.ts";
import { add, cmp } from "../money/money.ts";
import { filingAccountRef, type FilingAccountRef, type PayrollFilingAccount } from "./filing.ts";
import { addBusinessDays, holidayDateSet, nextBusinessDay, resolveObservedHolidays } from "./holidays.ts";
import { PayrollError } from "./error.ts";
import { allRemittanceSchedules, PAYROLL_COUNTRY_PACKS, remittanceFrequencyBand, remittanceScheduleInForce, type PayrollRemittanceFrequencyBand, type PayrollRemittanceSchedule } from "./packs.ts";

/** Remittance groups and their statutory schedules: grouping, frequencies, and due dates. */

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
   * authority, frequency, and due date — or null when no schedule governs.
   * An undated group refuses at billing rather than borrowing another
   * authority's timetable (see remittanceGroupDueDate).
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
  frequencySource: "configured" | "default" | "filing_account";
  /** The bill due date for the group's period, from the destination's schedule. */
  dueDate: string;
  /** The statutory rule applied, carried onto the bill like the CRA rules. */
  rule: string;
}

/** One remittance group = one destination vendor under one filing account. */
export function groupKey(partyId: string | null, filingAccountId: string | null): string {
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
   * vendor the accrual remitted to when it committed. Null for lines
   * committed while the component named no vendor; those resolve against
   * the component's vendor today (see component_party_id), and lines an
   * issued bill consumed resolve against that bill (see covered_party_id).
   */
  remittance_party_id: string | null;
  /** The component's CURRENT remittance vendor — the live assignment
   * unremitted snapshot-less liabilities resolve against. */
  component_party_id: string | null;
  /** The live (non-voided) remittance bill that consumed this row's lines,
   * or null while unremitted — the vendor history consumed lines keep. */
  covered_party_id: string | null;
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
export function remittanceMemo(
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

/** The `day`th of the month `offsetMonths` after the one `date` falls in. */
function dayOfMonth(date: string, offsetMonths: number, day: number): string {
  const [y, m] = date.split("-").map(Number);
  // Parts normalize like Date.UTC: month overflow carries into the year, and
  // day 31 in a short month rolls into the next month.
  return civilDateFromParts(y!, m! + offsetMonths, day);
}

export interface RemittanceDue {
  dueDate: string;
  /** The statutory rule applied, carried onto the bill so an operator can
   *  see WHY the date is what it is rather than trusting it. */
  rule: string;
}

/**
 * Resolve from the source the pack declares. A filing-account schedule must
 * have a remitter type on the group's account; missing attribution refuses.
 * Organization-configured schedules may use their published default when
 * no setting is recorded, with readiness prompting the operator to confirm it.
 */
export function scheduledRemittanceFrequency(
  schedule: PayrollRemittanceSchedule,
  payrollSettings: Record<string, unknown>,
  filingAccount: Pick<FilingAccountRef, "id" | "name" | "remitterType"> | null = null,
): { frequency: string; source: "configured" | "default" | "filing_account" } {
  if (schedule.frequencySource === "filing_account") {
    const frequency = filingAccount?.remitterType;
    if (!frequency || !remittanceFrequencyBand(schedule, frequency)) {
      throw new PayrollError(
        `${schedule.authority} remittance refuses: this group has no filing account with a declared remitter type — `
        + "assign a CRA filing account and set its remitter type in Payroll Setup → Filing accounts before dating the bill",
      );
    }
    return { frequency, source: "filing_account" };
  }
  const key = schedule.frequencySettingsKey;
  if (!key) {
    throw new PayrollError(`${schedule.authority} remittance schedule has no organization frequency setting key`);
  }
  const configured = payrollSettings[key];
  if (typeof configured === "string" && remittanceFrequencyBand(schedule, configured)) {
    return { frequency: configured, source: "configured" };
  }
  return { frequency: schedule.defaultFrequency, source: "default" };
}

/**
 * The due date for a remittance period under a pack-declared destination
 * schedule. The rule shapes are the schedule's data;
 * this function only executes them against the schedule's own calendar, so a
 * second agency's timetable is a second declaration, never a branch.
 *
 * Organization schedules may use their declared default when no setting is
 * recorded. Filing-account schedules refuse when the account has no declared
 * remitter type, because a CRA due date cannot be guessed from organization
 * settings.
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
        : endOfMonth(date);
      return {
        dueDate: addBusinessDays(periodEnd, band.due.workingDays, holidays),
        rule: band.rule,
      };
    }
  }
}

/**
 * The schedule governing one remittance group for one period end — the
 * destination-keyed schedule. Resolution order:
 *
 * 1. Provenance: a row that arrived through a scheduled destination's vendor
 *    key is governed by that schedule, even when the org left the vendor
 *    unconfigured (an unassigned RQ destination is still an RQ destination).
 *    A declared schedule always beats another destination's schedule, so a
 *    misconfigured org pointing two keys at one party still gets the declared date.
 * 2. Party: an `external` component pointed at a scheduled destination's
 *    configured vendor (Québec income tax remitted to the RQ vendor).
 *
 * Null when no pack declares the destination. Pure over an explicit schedule list, so the
 * precedence is verifiable without a database.
 */
export function scheduleForRemittanceGroup(input: {
  vendorKeys: readonly string[];
  partyId: string | null;
  periodTo: string;
  payrollSettings: Record<string, unknown>;
  filingAccount?: FilingAccountRef | null;
  regionalCalendar?: string | null;
  schedules?: readonly PayrollRemittanceSchedule[];
}): RemittanceGroupSchedule | null {
  const schedules = input.schedules ?? allRemittanceSchedules();
  const dated = [...new Set(input.vendorKeys)].flatMap((vendorSettingsKey) => {
    const schedule = remittanceScheduleInForce(vendorSettingsKey, input.periodTo, schedules);
    return schedule ? [{ vendorSettingsKey, schedule }] : [];
  });
  const byParty = (): { vendorSettingsKey: string; schedule: PayrollRemittanceSchedule }[] => {
    if (!input.partyId) return [];
    return schedules.flatMap((schedule) => {
      const configured = input.payrollSettings[schedule.vendorSettingsKey];
      if (typeof configured !== "string" || !configured || configured !== input.partyId) return [];
      const inForce = remittanceScheduleInForce(schedule.vendorSettingsKey, input.periodTo, schedules);
      return inForce ? [{ vendorSettingsKey: schedule.vendorSettingsKey, schedule: inForce }] : [];
    });
  };
  const candidates = dated.length ? dated : byParty();
  if (candidates.length > 1) {
    throw new PayrollError(
      `remittance group resolves to multiple declared destination schedules (${candidates.map((candidate) => candidate.vendorSettingsKey).join(", ")}) — `
      + "correct the destination mapping in Payroll Setup → Accounts so the group has one authority",
    );
  }
  const resolved = candidates[0] ?? null;
  if (!resolved || !resolved.schedule) return null;
  const { frequency, source } = scheduledRemittanceFrequency(
    resolved.schedule, input.payrollSettings, input.filingAccount ?? null,
  );
  const schedule = input.regionalCalendar
    ? { ...resolved.schedule, calendar: input.regionalCalendar }
    : resolved.schedule;
  const due = scheduledRemittanceDueDateExplained(schedule, frequency, input.periodTo);
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
 * The bill's dating rule, shared by the write path (createRemittanceBill)
 * and the read path (the agent's due-date forecast) so the two cannot
 * disagree. A destination without a pack-declared schedule refuses instead
 * of borrowing another authority's deadlines.
 */
export function remittanceGroupDueDate(
  group: Pick<RemittanceGroup, "schedule" | "vendorKeys" | "filingAccount" | "regionalCalendar">,
  periodTo: string,
): string {
  if (group.schedule) return group.schedule.dueDate;
  const destination = group.vendorKeys.length ? group.vendorKeys.join(", ") : "this remittance destination";
  throw new PayrollError(
    `no remittance schedule is declared for ${destination} for period ${periodTo} — `
    + "assign a pack-declared remittance destination in Payroll Setup → Accounts before dating the bill",
  );
}
