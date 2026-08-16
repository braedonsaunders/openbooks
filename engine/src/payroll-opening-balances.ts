import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, normalizeMoney } from "./money.ts";
import { PayrollError } from "./payroll-run.ts";

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
 * KNOWN GAP (deliberate, see .local/handoff-openings.md): opening balances are
 * whole-employee. Component-level YTD (a 402(g) elective-deferral or CRA
 * money-purchase basis cap consumed at the prior provider) has no opening
 * dimension at all, so `basis_cap_amount_per_year` restarts at adoption.
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

/** True when every amount is zero — an entered row that carries nothing. */
export function isEmptyOpeningBalance(amounts: OpeningBalanceAmounts): boolean {
  return OPENING_BALANCE_FIELDS.every((f) => cmp(amounts[f.key] ?? "0", "0") === 0);
}

interface LockRow {
  employee_party_id: string;
  document_number: string | null;
  pay_date: string;
}

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
  const rows = (await runner.execute(sql`
    select distinct on (s.employee_party_id)
           s.employee_party_id, d.document_number, s.pay_date::text as pay_date
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and r.run_status = 'committed'
     order by s.employee_party_id, s.pay_date
  `)) as unknown as { rows: LockRow[] };
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

  const rows = (await db.execute(sql`
    select p.id as employee_party_id, p.display_name as employee_name,
           er.employee_number, prof.country, prof.province,
           b.id is not null as has_row,
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
  `)) as unknown as { rows: Record<string, unknown>[] };

  // Rows for people who no longer have an active profile still exist and still
  // feed the engine, so surface them rather than pretending they are gone.
  const orphans = (await db.execute(sql`
    select b.employee_party_id, p.display_name as employee_name, er.employee_number,
           prof.country, prof.province, true as has_row, b.updated_at::text as updated_at,
           ${sql.join(amountCols, sql`, `)}
      from payroll_opening_balances b
      join parties p on p.id = b.employee_party_id and p.org_id = b.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = b.org_id
      left join employee_payroll_profiles prof
        on prof.org_id = b.org_id and prof.employee_party_id = b.employee_party_id
     where b.org_id = ${orgId} and b.tax_year = ${year}
       and (prof.id is null or not prof.is_active or not p.is_active)
     order by p.display_name
  `)) as unknown as { rows: Record<string, unknown>[] };

  const years = (await db.execute(sql`
    select distinct tax_year from payroll_opening_balances
     where org_id = ${orgId} order by tax_year desc
  `)) as unknown as { rows: { tax_year: number }[] };

  const locks = await openingBalanceLocks(orgId, year);
  const toRow = (raw: Record<string, unknown>): OpeningBalanceRow => {
    const employeePartyId = String(raw.employee_party_id);
    const lock = locks.get(employeePartyId) ?? null;
    const hasRow = raw.has_row === true;
    const amounts: OpeningBalanceAmounts = {};
    for (const field of OPENING_BALANCE_FIELDS) {
      amounts[field.key] = normalizeMoney(String(raw[field.column] ?? "0"));
    }
    return {
      employeePartyId,
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
  };
}

export interface OpeningBalanceWrite {
  employeePartyId: string;
  /** Any subset of OPENING_BALANCE_FIELDS keys; omitted amounts are zero. */
  amounts: Record<string, unknown>;
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
 * readiness warning disagree with the engine.
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
    const names = (await tx.execute(sql`
      select p.id, p.display_name from parties p
       where p.org_id = ${input.orgId} and p.id in (
         select (value->>'id')::uuid from jsonb_array_elements(${JSON.stringify(
           input.rows.map((r) => ({ id: r.employeePartyId })),
         )}::jsonb) as value)
    `)) as unknown as { rows: { id: string; display_name: string }[] };
    const nameById = new Map(names.rows.map((r) => [r.id, r.display_name]));

    const existing = (await tx.execute(sql`
      select employee_party_id from payroll_opening_balances
       where org_id = ${input.orgId} and tax_year = ${year}
    `)) as unknown as { rows: { employee_party_id: string }[] };
    const hasRow = new Set(existing.rows.map((r) => r.employee_party_id));

    const seen = new Set<string>();
    const planned: { employeePartyId: string; amounts: OpeningBalanceAmounts | null }[] = [];
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
        planned.push({
          employeePartyId: row.employeePartyId,
          amounts: isEmptyOpeningBalance(amounts) ? null : amounts,
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
        const deleted = (await tx.execute(sql`
          delete from payroll_opening_balances
           where org_id = ${input.orgId} and employee_party_id = ${row.employeePartyId}
             and tax_year = ${year}
           returning id
        `)) as unknown as { rows: { id: string }[] };
        if (deleted.rows.length > 0) {
          result.deleted++;
          await auditOpeningBalance(tx, {
            orgId: input.orgId, actorId: input.actorId, rowId: deleted.rows[0]!.id,
            action: "delete",
            changes: { employeePartyId: row.employeePartyId, taxYear: year },
          });
        }
        continue;
      }

      const values = OPENING_BALANCE_FIELDS.map((f) => sql`${row.amounts![f.key]}`);
      const updates = OPENING_BALANCE_FIELDS.map(
        (f) => sql`${sql.raw(f.column)} = excluded.${sql.raw(f.column)}`,
      );
      const saved = (await tx.execute(sql`
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
      `)) as unknown as { rows: { id: string }[] };
      const wasThere = hasRow.has(row.employeePartyId);
      if (wasThere) result.updated++;
      else result.created++;
      await auditOpeningBalance(tx, {
        orgId: input.orgId, actorId: input.actorId, rowId: saved.rows[0]!.id,
        action: wasThere ? "update" : "insert",
        changes: { employeePartyId: row.employeePartyId, taxYear: year, after: row.amounts },
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
