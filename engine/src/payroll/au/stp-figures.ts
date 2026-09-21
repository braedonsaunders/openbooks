/**
 * Pure STP finalisation figures: the row shape, the row-id grammar, the
 * financial-year label, and the STP gross derivation. A LEAF module — money
 * arithmetic and the pack's own AU_TAX_YEARS only, never the database — so
 * the no-database unit tests can import it directly. (The ES-pack TDZ
 * lesson applies here too: no runtime edge to `../packs.ts` or
 * `../filing-registry.ts`; the grammar is a local regex and the year comes
 * off ./rates.ts.)
 */
import { add, neg } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { AU_TAX_YEARS } from "./rates.ts";

/** One employee's STP year-to-date figures. All money is decimal strings. */
export interface AuStpFinalisationRow {
  employeePartyId: string;
  employeeName: string;
  /** Total YTD remuneration: every earning line, pre-sacrifice. */
  gross: string;
  /** …of which paid through the overtime component. */
  overtime: string;
  /** …of which paid through the bonus component (bonuses and commissions). */
  bonusesCommissions: string;
  /** …of which paid through the vacation-payout component. */
  paidLeave: string;
  /** YTD PAYG withholding (income tax + Medicare + STSL, one withholding). */
  paygWithheld: string;
  /** YTD superannuation guarantee LIABILITY accrued, not cash paid. */
  sgLiability: string;
  /** YTD pre-tax salary-sacrificed amounts (super/other split unsupported). */
  salarySacrifice: string;
  /** YTD ordinary-time-earnings base the SG liability was priced on. */
  oteBase: string;
}

/**
 * The STP-reportable gross for one row: the gross total less the amounts
 * STP wants separately itemised (ATO STP Phase 2 employer reporting
 * guidelines, "Disaggregation of gross"). Pure money.ts arithmetic.
 */
export function stpReportableGross(row: Pick<
  AuStpFinalisationRow, "gross" | "overtime" | "bonusesCommissions" | "paidLeave"
>): string {
  return add(add(add(row.gross, neg(row.overtime)), neg(row.bonusesCommissions)), neg(row.paidLeave));
}

/**
 * The row-id grammar, as the inverse of the population's bare-employee-id
 * construction. Owned HERE, beside the builder — the subsidiary-scope guard
 * parses through the declaration, never its own copy of this shape. Local
 * regex, not a shared import.
 */
const AU_STP_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseStpFinalisationRowId(rowId: string): { employees: string[]; accounts: string[] } | null {
  if (!AU_STP_ROW_UUID_RE.test(rowId)) return null;
  return { employees: [rowId], accounts: [] };
}

/** The FY label for a tax year off the pack's own edition declaration. */
export function auFinancialYearLabel(taxYear: number): string {
  const edition = AU_TAX_YEARS.editions.find((entry) => entry.year === taxYear);
  if (edition) return edition.label;
  return `${taxYear - 1}–${String(taxYear).slice(2)}`;
}

/**
 * The year-coverage refusal, read off AU_TAX_YEARS — never a calendar
 * assumption (`slice(0, 4)` is wrong for a 1-July fiscal pack) and never a
 * generic lookup (that would pull packs.ts in at runtime). Draft (2026) and
 * missing years each name the year, the pack, and the remedy. Pure, so the
 * refusal paths run in the no-database unit tests.
 */
export function assertAuFinalisationYear(taxYear: number): void {
  const published = AU_TAX_YEARS.editions
    .filter((entry) => entry.status === "published")
    .map((entry) => entry.year);
  if (published.includes(taxYear)) return;
  const draft = AU_TAX_YEARS.editions.some(
    (entry) => entry.year === taxYear && entry.status === "draft",
  );
  if (draft) {
    throw new PayrollPackError(
      `AU STP finalisation for ${auFinancialYearLabel(taxYear)} (taxYear ${taxYear}) is refused: `
      + `the ${taxYear} statutory tables for AU are scaffolded but not filled in — the draft `
      + `edition still carries placeholder values. Transcribe the published ATO figures before finalising ${taxYear}.`,
    );
  }
  throw new PayrollPackError(
    `AU STP finalisation for taxYear ${taxYear} is refused: ${taxYear} statutory tables are not loaded for AU — `
    + (published.length > 0 ? `loaded years: ${published.join(", ")}. ` : "no years are loaded. ")
    + "Transcribe the year's ATO legislation before finalising.",
  );
}
