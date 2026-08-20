import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, normalizeMoney } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";

/**
 * Mid-year adoption: the statutory year-to-date an employer accumulated on a
 * previous payroll system, carried into OpenBooks so the first run here
 * continues the year instead of restarting it.
 *
 * `payroll_opening_balances` is the ONLY input for the annual ceilings —
 * CPP/CPP2/EI/QPIP maximums, the US Social Security and FUTA/SUTA wage bases,
 * and the non-periodic (bonus-method) year-to-date. `employeeYtd` and
 * `usEmployeeYtd` in payroll-run.ts add these rows to the committed stubs and
 * treat the sum as the whole truth. An employer that adopts on any date but
 * 1 January and loads none therefore re-withholds up to a SECOND full annual
 * maximum per employee (roughly $5,350 of CPP + EI in 2026), and every T4/W-2
 * box understates the year.
 *
 * This module is the single write path. Two controls live here rather than in
 * the UI, because either one enforced only by a screen is not enforced:
 *
 *  1. An opening balance is IMMUTABLE for an employee/tax-year once a run has
 *     committed for them in that year. Editing it afterwards silently restates
 *     withholding that has already been taken from a real cheque and remitted.
 *     Correcting a genuinely wrong carry-in is a reversal exercise (void the
 *     runs), not a quiet update, so this refuses loudly.
 *  2. Amounts are validated as exact money, are never negative, and each
 *     contribution is checked against the base it was withheld from. A
 *     transposed column in a prior-provider export — CPP dollars pasted into
 *     pensionable earnings — is the realistic way this data goes wrong, and it
 *     is silent unless something looks.
 *
 * A carry-in has TWO dimensions, both anchored on the same row and frozen by
 * the same committed run:
 *
 *  - the statutory year-to-date, in `payroll_opening_balances`' own columns;
 *  - the COMPONENT year-to-date, in `payroll_opening_balance_components`
 *    beneath it — one amount per component carrying an annual basis cap
 *    (`pay_components.basis_cap_amount_per_year`: the CRA money-purchase limit,
 *    the US 402(g) elective-deferral limit). `componentYearToDate` in
 *    payroll-run.ts sums those openings with the committed stub lines, so a
 *    mid-year adopter does not hand every employee a SECOND full annual limit.
 *
 * Entitlement banks (vacation, banked time) are the third dimension and live
 * elsewhere on purpose: a bank is not year-scoped, so it is an
 * `entitlement_ledger` movement with `kind = 'opening'`, loaded through
 * engine/src/payroll-entitlements.ts. `vacation_balance` on this table is the
 * deprecated ancestor of that and is deliberately not editable here — see the
 * schema comment.
 */

/** Amount an opening balance carries, and which country packs read it. */
export interface OpeningBalanceField {
  /** camelCase API / import-file key. */
  key: string;
  /** payroll_opening_balances column. */
  column: string;
  /** Country packs the amount means something for. */
  packs: readonly ("CA" | "US")[];
  /** English fallback label; the UI localizes by key and falls back to this. */
  label: string;
  /** What the operator copies out of the prior provider's YTD report. */
  help: string;
}

/**
 * The maintainable amounts, in entry order.
 *
 * `vacation_balance` is deliberately NOT here. No pay run reads it any more —
 * it survives only as the input to scripts/migrate-vacation-to-entitlements.ts,
 * because an opening vacation balance is now an entitlement_ledger row against
 * a pay bank. Offering it as an editable field would be a setting that changes
 * nothing.
 */
export const OPENING_BALANCE_FIELDS: readonly OpeningBalanceField[] = [
  {
    key: "pensionableYtd", column: "pensionable_ytd", packs: ["CA", "US"],
    label: "Pensionable / FICA wages",
    help: "CPP pensionable earnings (Canada) or Social Security and Medicare wages (US) paid this year before adoption.",
  },
  {
    key: "insurableYtd", column: "insurable_ytd", packs: ["CA", "US"],
    label: "Insurable / unemployment wages",
    help: "EI insurable earnings (Canada) or FUTA and state-unemployment wages (US) paid this year before adoption.",
  },
  {
    key: "cppYtd", column: "cpp_ytd", packs: ["CA"],
    label: "CPP contributions",
    help: "Employee CPP (or QPP) contributions already withheld this year.",
  },
  {
    key: "cpp2Ytd", column: "cpp2_ytd", packs: ["CA"],
    label: "CPP2 contributions",
    help: "Second additional CPP contributions already withheld this year.",
  },
  {
    key: "eiYtd", column: "ei_ytd", packs: ["CA"],
    label: "EI premiums",
    help: "Employee EI premiums already withheld this year.",
  },
  {
    key: "qpipYtd", column: "qpip_ytd", packs: ["CA"],
    label: "QPIP premiums",
    help: "Employee QPIP premiums already withheld this year (Quebec).",
  },
  {
    key: "taxableYtd", column: "taxable_ytd", packs: ["CA", "US"],
    label: "Taxable earnings",
    help: "Taxable employment income paid this year before adoption (T4 box 14 / W-2 box 1).",
  },
  {
    key: "taxYtd", column: "tax_ytd", packs: ["CA", "US"],
    label: "Income tax withheld",
    help: "Federal (and provincial, where combined) income tax already withheld this year.",
  },
  {
    key: "nonPeriodicYtd", column: "non_periodic_ytd", packs: ["CA", "US"],
    label: "Bonus / supplemental earnings",
    help: "Bonuses and other non-periodic earnings paid this year — the bonus-method year-to-date.",
  },
] as const;

const FIELD_BY_KEY = new Map(OPENING_BALANCE_FIELDS.map((f) => [f.key, f]));

/** Amounts of one opening balance, keyed like OPENING_BALANCE_FIELDS. */
export type OpeningBalanceAmounts = Record<string, string>;

/**
 * A component whose annual basis cap makes an opening year-to-date meaningful.
 *
 * Deliberately NOT pack-scoped, unlike OPENING_BALANCE_FIELDS. A per-year basis
 * cap is TENANT configuration on the component — the operator enters the CRA
 * money-purchase limit or the 402(g) limit for the plan they actually run — so
 * there is nothing jurisdiction-specific for a country pack to declare here and
 * no field every pack would answer identically. The mechanism is the same in
 * every country: whatever the tenant capped annually, an adopter must be able
 * to say how much of it is already gone.
 */
export interface OpeningComponentField {
  componentId: string;
  code: string;
  name: string;
  kind: "earning" | "deduction" | "employer_contribution";
  /** The annual ceiling this carry-in consumes; null once a cap is removed. */
  basisCapAmountPerYear: string | null;
  /**
   * False when the component no longer carries an annual cap but an opening was
   * stored against it. The amount is kept and shown (it is a historical fact
   * somebody entered), it is simply inert until a cap comes back — and it may
   * not be re-entered, because entering a number that changes nothing is the
   * setting this codebase refuses to offer.
   */
  capped: boolean;
}

/** Component openings for one carry-in: componentId → amount. */
export type OpeningComponentAmounts = Record<string, string>;

export interface OpeningBalanceRow {
  employeePartyId: string;
  employeeName: string;
  employeeNumber: string | null;
  /** Country pack the employee runs under — decides which amounts apply. */
  country: string | null;
  province: string | null;
  taxYear: number;
  /** Present only when a row has been entered. */
  amounts: OpeningBalanceAmounts | null;
  /** componentId → opening year-to-date; empty when none were entered. */
  componentAmounts: OpeningComponentAmounts;
  /**
   * A run has committed for this employee in this tax year, so the carry-in is
   * already inside withholding that has been paid out. Read-only from here.
   */
  locked: boolean;
  /** The committed run that locked it (the evidence for refusing an edit). */
  lockedBy: { documentNumber: string | null; payDate: string } | null;
  updatedAt: string | null;
}

export interface OpeningBalanceYear {
  taxYear: number;
  rows: OpeningBalanceRow[];
  /** Employees with a row, of the active payroll population. */
  entered: number;
  /** Tax years that already carry at least one opening balance. */
  years: number[];
  /** Annually-capped components that need a carry-in, in code order. */
  components: OpeningComponentField[];
}

export class OpeningBalanceLockedError extends PayrollError {}

const MIN_TAX_YEAR = 2000;
const MAX_TAX_YEAR = 2100;

export function assertTaxYear(taxYear: unknown): number {
  const year = Number(taxYear);
  if (!Number.isInteger(year) || year < MIN_TAX_YEAR || year > MAX_TAX_YEAR) {
    throw new PayrollError(`tax year must be an integer between ${MIN_TAX_YEAR} and ${MAX_TAX_YEAR}`);
  }
  return year;
}

/**
 * Canonicalize one employee's amounts. Every value goes through the bigint
 * money helpers — a prior provider's export is untrusted text, and a float
 * round-trip here would land a wrong ceiling in the first run's CPP.
 */
export function normalizeOpeningBalance(input: Record<string, unknown>): OpeningBalanceAmounts {
  const amounts: OpeningBalanceAmounts = {};
  for (const field of OPENING_BALANCE_FIELDS) {
    const raw = input[field.key];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      amounts[field.key] = "0.0000";
      continue;
    }
    let value: string;
    try {
      value = normalizeMoney(String(raw).trim().replace(/[,$]/g, ""));
    } catch {
      throw new PayrollError(`${field.label} is not an amount: "${String(raw)}"`);
    }
    // A year-to-date is money already paid or withheld. Negative is either a
    // sign-flipped export or a refund somebody meant to record as a pay run.
    if (cmp(value, "0") < 0) throw new PayrollError(`${field.label} cannot be negative`);
    amounts[field.key] = value;
  }

  // Cross-field sanity: a contribution can never exceed the base it came out
  // of. This is the check that catches a column transposed in a spreadsheet,
  // which is otherwise invisible until the first stub withholds nothing.
  const over = (amount: string, base: string, what: string, baseWhat: string) => {
    if (cmp(amounts[amount]!, amounts[base]!) > 0) {
      throw new PayrollError(`${what} (${amounts[amount]}) exceeds ${baseWhat} (${amounts[base]}) — check the columns`);
    }
  };
  if (cmp(add(amounts.cppYtd!, amounts.cpp2Ytd!), amounts.pensionableYtd!) > 0) {
    throw new PayrollError(
      `CPP + CPP2 contributions (${add(amounts.cppYtd!, amounts.cpp2Ytd!)}) exceed pensionable earnings (${amounts.pensionableYtd}) — check the columns`,
    );
  }
  over("eiYtd", "insurableYtd", "EI premiums", "insurable earnings");
  over("taxYtd", "taxableYtd", "Income tax withheld", "taxable earnings");
  over("nonPeriodicYtd", "taxableYtd", "Bonus / supplemental earnings", "taxable earnings");
  return amounts;
}

/**
 * Canonicalize one employee's COMPONENT openings, keyed by component id.
 *
 * Keys may be a component uuid (the API) or its `code` (an import file column),
 * because both callers name the same fact and neither should own a second
 * resolver. Everything unresolvable, inactive, uncapped, or above its own cap
 * is REFUSED by name — the cases this rejects are the realistic ones:
 *
 *  - a component code the file has but this org does not (a stale template);
 *  - a component with no annual cap, where an opening would change nothing.
 *    Storing an inert number that silently starts mattering the day somebody
 *    sets a cap is worse than refusing and saying which setting is missing;
 *  - an amount above the annual ceiling, which is arithmetically impossible and
 *    is how a transposed spreadsheet column shows up.
 */
export function normalizeOpeningComponents(
  input: Record<string, unknown>,
  components: readonly OpeningComponentField[],
): OpeningComponentAmounts {
  const byKey = new Map<string, OpeningComponentField>();
  for (const component of components) {
    byKey.set(component.componentId, component);
    byKey.set(component.code.trim().toLowerCase(), component);
  }
  const amounts: OpeningComponentAmounts = {};
  for (const [rawKey, raw] of Object.entries(input)) {
    const key = String(rawKey).trim();
    const component = byKey.get(key) ?? byKey.get(key.toLowerCase());
    if (!component) {
      throw new PayrollError(
        `"${key}" is not an annually-capped pay component in this organization`,
      );
    }
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    let value: string;
    try {
      value = normalizeMoney(String(raw).trim().replace(/[,$]/g, ""));
    } catch {
      throw new PayrollError(`${component.name} year-to-date is not an amount: "${String(raw)}"`);
    }
    if (cmp(value, "0") < 0) {
      throw new PayrollError(`${component.name} year-to-date cannot be negative`);
    }
    if (cmp(value, "0") === 0) continue; // zero is "no carry-in", not a row
    if (!component.capped || component.basisCapAmountPerYear == null) {
      throw new PayrollError(
        `${component.name} has no annual basis cap, so an opening year-to-date for it would `
        + "change nothing — set the component's per-year cap first",
      );
    }
    if (cmp(value, component.basisCapAmountPerYear) > 0) {
      throw new PayrollError(
        `${component.name} year-to-date (${value}) exceeds its annual cap `
        + `(${component.basisCapAmountPerYear}) — check the columns`,
      );
    }
    amounts[component.componentId] = value;
  }
  return amounts;
}

/**
 * True when every amount is zero — an entered row that carries nothing.
 *
 * `components` is part of the test, not an afterthought: the caller DELETES a
 * row this returns true for, so an employee whose only carry-in is a 402(g)
 * year-to-date must not be judged empty by the statutory columns alone and have
 * their deferral room silently cascade away.
 */
export function isEmptyOpeningBalance(
  amounts: OpeningBalanceAmounts,
  components: OpeningComponentAmounts = {},
): boolean {
  if (Object.values(components).some((amount) => cmp(amount ?? "0", "0") !== 0)) return false;
  return OPENING_BALANCE_FIELDS.every((f) => cmp(amounts[f.key] ?? "0", "0") === 0);
}

/** Stored openings whose component no longer carries an annual cap. */
function inertOpenings(
  stored: OpeningComponentAmounts,
  components: readonly OpeningComponentField[],
): OpeningComponentAmounts {
  const inert = new Set(components.filter((c) => !c.capped).map((c) => c.componentId));
  return Object.fromEntries(
    Object.entries(stored).filter(([componentId]) => inert.has(componentId)),
  );
}

/**
 * Components an opening year-to-date is meaningful for: everything active that
 * carries an annual basis cap, plus anything that already holds an opening in
 * this tax year, so removing a cap can never hide data somebody entered.
 */
export async function openingComponentFields(
  orgId: string,
  /** Year whose stored openings widen the list; null = every year (import/export). */
  taxYear: number | null,
  runner: Pick<typeof db, "execute"> = db,
): Promise<OpeningComponentField[]> {
  const rows = (await runner.execute<Record<string, unknown>>(sql`
    select c.id, c.code, c.name, c.kind, c.basis_cap_amount_per_year
      from pay_components c
     where c.org_id = ${orgId}
       and ((c.is_active and c.basis_cap_amount_per_year is not null)
            or exists (
              select 1 from payroll_opening_balance_components oc
                join payroll_opening_balances b
                  on b.id = oc.opening_balance_id and b.org_id = oc.org_id
               where oc.org_id = ${orgId} and oc.component_id = c.id
                 and (${taxYear}::int is null or b.tax_year = ${taxYear}::int)))
     order by c.code
  `));
  return rows.rows.map((row) => ({
    componentId: String(row.id),
    code: String(row.code),
    name: String(row.name),
    kind: String(row.kind) as OpeningComponentField["kind"],
    basisCapAmountPerYear: row.basis_cap_amount_per_year == null
      ? null
      : normalizeMoney(String(row.basis_cap_amount_per_year)),
    capped: row.basis_cap_amount_per_year != null,
  }));
}
type LockRow = {
  employee_party_id: string;
  document_number: string | null;
  pay_date: string;
};

/**
 * Employees whose carry-in is already baked into a committed pay. A stub on a
 * committed run for the tax year is the whole test: that run's CPP/EI was
 * computed against this opening balance and the money has left the bank.
 */
export async function openingBalanceLocks(
  orgId: string,
  taxYear: number,
  runner: Pick<typeof db, "execute"> = db,
): Promise<Map<string, { documentNumber: string | null; payDate: string }>> {
  const rows = (await runner.execute<LockRow>(sql`
    select distinct on (s.employee_party_id)
           s.employee_party_id, d.document_number, s.pay_date::text as pay_date
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and r.run_status = 'committed'
     order by s.employee_party_id, s.pay_date
  `));
  return new Map(
    rows.rows.map((r) => [r.employee_party_id, { documentNumber: r.document_number, payDate: r.pay_date }]),
  );
}

/**
 * The whole active payroll population for one tax year, with their carry-in
 * where one exists. Adoption is a whole-workforce exercise, so employees
 * WITHOUT a row are returned too — an empty grid that has to be discovered
 * employee by employee is how people get missed.
 */
export async function openingBalancesForYear(orgId: string, taxYear: number): Promise<OpeningBalanceYear> {
  const year = assertTaxYear(taxYear);
  const amountCols = OPENING_BALANCE_FIELDS.map((f) => sql.raw(`b.${f.column}`));

  const rows = (await db.execute<Record<string, unknown>>(sql`
    select p.id as employee_party_id, p.display_name as employee_name,
           er.employee_number, prof.country, prof.province,
           b.id is not null as has_row, b.id as row_id,
           b.updated_at::text as updated_at,
           ${sql.join(amountCols, sql`, `)}
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id
      left join payroll_opening_balances b
        on b.org_id = prof.org_id and b.employee_party_id = prof.employee_party_id
       and b.tax_year = ${year}
     where prof.org_id = ${orgId} and prof.is_active and p.is_active
     order by p.display_name
  `));

  // Rows for people who no longer have an active profile still exist and still
  // feed the engine, so surface them rather than pretending they are gone.
  const orphans = (await db.execute<Record<string, unknown>>(sql`
    select b.employee_party_id, p.display_name as employee_name, er.employee_number,
           prof.country, prof.province, true as has_row, b.id as row_id,
           b.updated_at::text as updated_at,
           ${sql.join(amountCols, sql`, `)}
      from payroll_opening_balances b
      join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = b.org_id
      left join employee_payroll_profiles prof
        on prof.org_id = b.org_id and prof.employee_party_id = b.employee_party_id
     where b.org_id = ${orgId} and b.tax_year = ${year}
       and (prof.id is null or not prof.is_active or not p.is_active)
     order by p.display_name
  `));

  const years = (await db.execute<{ tax_year: number }>(sql`
    select distinct tax_year from payroll_opening_balances
     where org_id = ${orgId} order by tax_year desc
  `));

  const components = await openingComponentFields(orgId, year);

  // Component openings for the whole year in one pass, keyed by parent row.
  const componentRows = (await db.execute<{ opening_balance_id: string; component_id: string; ytd_amount: string }>(sql`
    select oc.opening_balance_id, oc.component_id, oc.ytd_amount
      from payroll_opening_balance_components oc
      join payroll_opening_balances b on b.id = oc.opening_balance_id and b.org_id = oc.org_id
     where oc.org_id = ${orgId} and b.tax_year = ${year}
  `));
  const componentsByRow = new Map<string, OpeningComponentAmounts>();
  for (const row of componentRows.rows) {
    const amounts = componentsByRow.get(row.opening_balance_id) ?? {};
    amounts[row.component_id] = normalizeMoney(String(row.ytd_amount));
    componentsByRow.set(row.opening_balance_id, amounts);
  }

  const locks = await openingBalanceLocks(orgId, year);
  const toRow = (raw: Record<string, unknown>): OpeningBalanceRow => {
    const employeePartyId = String(raw.employee_party_id);
    const lock = locks.get(employeePartyId) ?? null;
    const hasRow = raw.has_row === true;
    const amounts: OpeningBalanceAmounts = {};
    for (const field of OPENING_BALANCE_FIELDS) {
      amounts[field.key] = normalizeMoney(String(raw[field.column] ?? "0"));
    }
    const rowId = raw.row_id == null ? null : String(raw.row_id);
    return {
      employeePartyId,
      componentAmounts: (rowId && componentsByRow.get(rowId)) || {},
      employeeName: String(raw.employee_name ?? ""),
      employeeNumber: raw.employee_number == null ? null : String(raw.employee_number),
      country: raw.country == null ? null : String(raw.country),
      province: raw.province == null ? null : String(raw.province),
      taxYear: year,
      amounts: hasRow ? amounts : null,
      locked: lock !== null,
      lockedBy: lock,
      updatedAt: raw.updated_at == null ? null : String(raw.updated_at),
    };
  };

  const all = [...rows.rows.map(toRow), ...orphans.rows.map(toRow)];
  return {
    taxYear: year,
    rows: all,
    entered: all.filter((r) => r.amounts !== null).length,
    years: years.rows.map((r) => Number(r.tax_year)),
    components,
  };
}

export interface OpeningBalanceWrite {
  employeePartyId: string;
  /** Any subset of OPENING_BALANCE_FIELDS keys; omitted amounts are zero. */
  amounts: Record<string, unknown>;
  /**
   * Component openings, keyed by component id OR code; omitted components keep
   * nothing. `undefined` means "this caller does not speak components" and
   * leaves whatever is stored alone — an empty object means "clear them", which
   * is what the grid and the importer both send.
   */
  components?: Record<string, unknown>;
}

export interface OpeningBalanceSaveResult {
  created: number;
  updated: number;
  deleted: number;
  /** Rows that could not be written, and why. Nothing is written on failure. */
  errors: { employeePartyId: string; employeeName?: string; message: string }[];
}

/**
 * Create or replace opening balances for one tax year, all-or-nothing.
 *
 * Adoption is a bulk load from a prior provider's report, so a partial write
 * is the worst outcome available: half a workforce carried in and half
 * restarted at zero is harder to detect than an outright failure. Every row is
 * validated first; a single rejection aborts the transaction and reports every
 * problem at once.
 *
 * An all-zero row is a DELETE, not a row of zeros: "no carry-in" and "carry-in
 * of nothing" are the same fact, and keeping both representations lets the
 * readiness warning disagree with the engine. "All-zero" spans the component
 * openings — otherwise clearing the statutory columns would cascade an
 * employee's 402(g) year-to-date away with no trace.
 *
 * A caller that omits `components` entirely (an older client, a file with no
 * component columns) has its STORED components carried forward rather than
 * dropped. Silence is not an instruction to delete.
 */
export async function saveOpeningBalances(input: {
  orgId: string;
  actorId: string;
  taxYear: number;
  rows: OpeningBalanceWrite[];
  /** Reject (rather than skip) rows locked by a committed run. Default true. */
  strictLocks?: boolean;
}): Promise<OpeningBalanceSaveResult> {
  const year = assertTaxYear(input.taxYear);
  const result: OpeningBalanceSaveResult = { created: 0, updated: 0, deleted: 0, errors: [] };
  if (input.rows.length === 0) return result;

  return db.transaction(async (tx) => {
    const locks = await openingBalanceLocks(input.orgId, year, tx);

    // Employees must belong to this org. Resolving names in one pass also
    // gives every error message something a human can act on.
    const names = (await tx.execute<{ id: string; display_name: string }>(sql`
      select p.id, p.display_name from parties p
       where p.org_id = ${input.orgId} and p.id in (
         select (value->>'id')::uuid from jsonb_array_elements(${JSON.stringify(
           input.rows.map((r) => ({ id: r.employeePartyId })),
         )}::jsonb) as value)
    `));
    const nameById = new Map(names.rows.map((r) => [r.id, r.display_name]));

    const existing = (await tx.execute<{ employee_party_id: string }>(sql`
      select employee_party_id from payroll_opening_balances
       where org_id = ${input.orgId} and tax_year = ${year}
    `));
    const hasRow = new Set(existing.rows.map((r) => r.employee_party_id));

    // Component descriptors resolve names/codes and enforce the annual cap;
    // stored amounts are what a caller that says nothing about components keeps.
    const componentFields = await openingComponentFields(input.orgId, year, tx);
    const storedComponents = (await tx.execute<{ employee_party_id: string; component_id: string; ytd_amount: string }>(sql`
      select b.employee_party_id, oc.component_id, oc.ytd_amount
        from payroll_opening_balance_components oc
        join payroll_opening_balances b on b.id = oc.opening_balance_id and b.org_id = oc.org_id
       where oc.org_id = ${input.orgId} and b.tax_year = ${year}
    `));
    const storedByEmployee = new Map<string, OpeningComponentAmounts>();
    for (const row of storedComponents.rows) {
      const amounts = storedByEmployee.get(row.employee_party_id) ?? {};
      amounts[row.component_id] = normalizeMoney(String(row.ytd_amount));
      storedByEmployee.set(row.employee_party_id, amounts);
    }

    const seen = new Set<string>();
    const planned: {
      employeePartyId: string;
      amounts: OpeningBalanceAmounts | null;
      components: OpeningComponentAmounts;
    }[] = [];
    for (const row of input.rows) {
      const employeeName = nameById.get(row.employeePartyId);
      const fail = (message: string) =>
        result.errors.push({ employeePartyId: row.employeePartyId, employeeName, message });
      if (!employeeName) {
        fail("employee not found in this organization");
        continue;
      }
      if (seen.has(row.employeePartyId)) {
        fail("appears more than once in this load");
        continue;
      }
      seen.add(row.employeePartyId);
      const lock = locks.get(row.employeePartyId);
      if (lock && input.strictLocks !== false) {
        fail(
          `a pay run committed on ${lock.payDate}${lock.documentNumber ? ` (${lock.documentNumber})` : ""} already used this carry-in for ${year}; void that run before changing it`,
        );
        continue;
      }
      if (lock) continue; // non-strict bulk load: leave locked employees alone
      try {
        const amounts = normalizeOpeningBalance(row.amounts);
        const stored = storedByEmployee.get(row.employeePartyId) ?? {};
        const components = row.components === undefined
          ? stored
          : {
            // An opening against a component whose annual cap has since been
            // removed is INERT but real — somebody entered it, and a cap may
            // come back. Nobody may re-enter it (that is the refusal in
            // normalizeOpeningComponents) and nobody may clear it by omission
            // either, so it is carried forward unconditionally.
            ...inertOpenings(stored, componentFields),
            ...normalizeOpeningComponents(row.components, componentFields),
          };
        planned.push({
          employeePartyId: row.employeePartyId,
          amounts: isEmptyOpeningBalance(amounts, components) ? null : amounts,
          components,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : "invalid amounts");
      }
    }

    if (result.errors.length > 0) {
      // Nothing partial: raise so the transaction unwinds, carrying the full
      // error list back to the caller.
      throw new OpeningBalanceSaveError(result);
    }

    const columns = OPENING_BALANCE_FIELDS.map((f) => f.column);
    for (const row of planned) {
      if (row.amounts === null) {
        const deleted = (await tx.execute<{ id: string }>(sql`
          delete from payroll_opening_balances
           where org_id = ${input.orgId} and employee_party_id = ${row.employeePartyId}
             and tax_year = ${year}
           returning id
        `));
        if (deleted.rows.length > 0) {
          result.deleted++;
          // The children cascade with the parent. Naming what they held is the
          // audit evidence: a component year-to-date that vanishes without a
          // record of its value cannot be reconstructed from the trail.
          await auditOpeningBalance(tx, {
            orgId: input.orgId, actorId: input.actorId, rowId: deleted.rows[0]!.id,
            action: "delete",
            changes: {
              employeePartyId: row.employeePartyId, taxYear: year,
              beforeComponents: storedByEmployee.get(row.employeePartyId) ?? {},
            },
          });
        }
        continue;
      }

      const values = OPENING_BALANCE_FIELDS.map((f) => sql`${row.amounts![f.key]}`);
      const updates = OPENING_BALANCE_FIELDS.map(
        (f) => sql`${sql.raw(f.column)} = excluded.${sql.raw(f.column)}`,
      );
      const saved = (await tx.execute<{ id: string }>(sql`
        insert into payroll_opening_balances
          (org_id, employee_party_id, tax_year, ${sql.raw(columns.join(", "))}, created_by, updated_by)
        values
          (${input.orgId}, ${row.employeePartyId}, ${year}, ${sql.join(values, sql`, `)},
           ${input.actorId}, ${input.actorId})
        on conflict (org_id, employee_party_id, tax_year) do update
           set ${sql.join(updates, sql`, `)},
               updated_by = ${input.actorId},
               updated_at = now()
        returning id
      `));
      const rowId = saved.rows[0]!.id;

      // Component openings are REPLACED as a set, in the same transaction and
      // against the same row id. Anything not named is gone: a re-load of the
      // provider's report is the whole truth about that employee's year, and
      // leaving an orphaned amount behind would consume deferral room the file
      // says is available.
      const keep = Object.keys(row.components);
      if (keep.length === 0) {
        await tx.execute(sql`
          delete from payroll_opening_balance_components
           where org_id = ${input.orgId} and opening_balance_id = ${rowId}`);
      } else {
        await tx.execute(sql`
          delete from payroll_opening_balance_components
           where org_id = ${input.orgId} and opening_balance_id = ${rowId}
             and component_id <> all(${`{${keep.join(",")}}`}::uuid[])`);
        for (const [componentId, amount] of Object.entries(row.components)) {
          await tx.execute(sql`
            insert into payroll_opening_balance_components
              (org_id, opening_balance_id, component_id, ytd_amount, created_by, updated_by)
            values (${input.orgId}, ${rowId}, ${componentId}, ${amount},
                    ${input.actorId}, ${input.actorId})
            on conflict (opening_balance_id, component_id) do update
               set ytd_amount = excluded.ytd_amount,
                   updated_by = ${input.actorId},
                   updated_at = now()`);
        }
      }

      const wasThere = hasRow.has(row.employeePartyId);
      if (wasThere) result.updated++;
      else result.created++;
      await auditOpeningBalance(tx, {
        orgId: input.orgId, actorId: input.actorId, rowId,
        action: wasThere ? "update" : "insert",
        changes: {
          employeePartyId: row.employeePartyId, taxYear: year,
          after: row.amounts, afterComponents: row.components,
        },
      });
    }

    return result;
  });
}

/** Carries every rejected row out of the aborted transaction. */
export class OpeningBalanceSaveError extends PayrollError {
  constructor(readonly result: OpeningBalanceSaveResult) {
    super(result.errors[0]?.message ?? "opening balances were rejected");
  }
}

async function auditOpeningBalance(
  runner: Pick<typeof db, "execute">,
  args: {
    orgId: string; actorId: string; rowId: string;
    action: "insert" | "update" | "delete";
    changes: Record<string, unknown>;
  },
): Promise<void> {
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'payroll_opening_balances', ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`);
}

/** Field descriptor by key, for callers that map an import column onto one. */
export function openingBalanceField(key: string): OpeningBalanceField | undefined {
  return FIELD_BY_KEY.get(key);
}

/**
 * One component's year-to-date for an employee: every committed stub line for
 * the component in the tax year, PLUS the opening carry-in.
 *
 * This is the number `pay_components.basis_cap_amount_per_year` is enforced
 * against, so it is the number a mid-year adopter's carry-in has to reach. It
 * lives here, not in the pay run, because the two halves are one fact and had
 * drifted: `calculateStub`'s local version summed only the stubs while its
 * comment claimed openings were "included via the opening-balance sweep the
 * year-end module owns" — a sweep that does not exist. An annual ceiling that
 * silently restarts is worse than one that is absent, because the stub looks
 * right: the employee simply gets a second full 402(g) or money-purchase limit,
 * and the excess contribution is the employer's to unwind with the regulator.
 *
 * `excludeRunDocumentId` keeps the run being calculated out of its own basis, so
 * recalculating converges instead of ratcheting the cap down each pass.
 */
export async function componentYearToDate(
  executor: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    employeePartyId: string;
    taxYear: number;
    componentId: string;
    excludeRunDocumentId?: string | null;
  },
): Promise<string> {
  const exclude = args.excludeRunDocumentId ?? null;
  const r = (await executor.execute<{ ytd: string }>(sql`
    select (
      coalesce((
        select sum(l.amount) from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where l.org_id = ${args.orgId} and s.employee_party_id = ${args.employeePartyId}
           and s.tax_year = ${args.taxYear} and l.component_id = ${args.componentId}
           and r.run_status = 'committed'
           and (${exclude}::uuid is null or s.pay_run_document_id <> ${exclude}::uuid)
      ), 0)
      + coalesce((
        select oc.ytd_amount from payroll_opening_balance_components oc
          join payroll_opening_balances b on b.id = oc.opening_balance_id and b.org_id = oc.org_id
         where oc.org_id = ${args.orgId} and b.employee_party_id = ${args.employeePartyId}
           and b.tax_year = ${args.taxYear} and oc.component_id = ${args.componentId}
      ), 0)
    )::text as ytd
  `));
  return normalizeMoney(String(r.rows[0]?.ytd ?? "0"));
}
