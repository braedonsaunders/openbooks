import { sql } from "drizzle-orm";
import { cmp, fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import type { db } from "../../platform/db.ts";
import type { PushStatutoryFn } from "../statutory-context.ts";
import { ItPayrollRefusal } from "./refusal.ts";

/**
 * The addizionali assessed-saldo channel.
 *
 * THE LAW. The regional addizionale is settled at the conguaglio and
 * withheld in up to 11 installments afterwards (D.Lgs. 15 dicembre 1997,
 * n. 446, art. 50 c. 2 e 4:
 * https://www.normattiva.it/uri-res/N2Ls?urn%3Anir%3Astato%3Adecreto.legislativo%3A1997-12-15%3B446~art50=).
 * The comunale addizionale's saldo rides the March–November ninths with the
 * 30% current-year advance (D.Lgs. 28 settembre 1998, n. 360, art. 1 c. 4–5:
 * https://www.normattiva.it/uri-res/N2Ls?urn%3Anir%3Astato%3Adecreto.legislativo%3A1998-09-28%3B360=;
 * INPS scheda addizionali regionali e comunali:
 * https://www.inps.it/it/it/dettaglio-approfondimento.schede-informative.53546.pensioni-addizionali-irpef-regionali-e-comunali.html).
 * The engine prices the saldo installments here; the 30% comunale acconto
 * keeps its own (unmodelled) schedule — the monthly advances pace the full
 * current-year liability and the December conguaglio settles the combined
 * position, so the acconto timing difference is absorbed, never refused.
 *
 * THE SOURCES, in order. The year N-1 assessment is:
 * 1. the employee's committed year N-1 December settlement, when OpenBooks
 *    ran that year — the CONG_ADDREG_ANNUAL / CONG_ADDCOM_ANNUAL factors the
 *    conguaglio stamps (engine/src/payroll/it/conguaglio.ts); only December
 *    stubs carry CONG_ keys, so factor presence IS the settlement's
 *    existence proof, and a voided run's figures never count;
 * 2. otherwise the explicit per-employee carry-in row in
 *    it_addizionali_opening_balances for year N (migration 0393) — row
 *    presence is the declaration, including an explicit zero for a worker
 *    with no prior-year Italian employment.
 * Neither existing is the only refusal, by name, with both remedies. Zero is
 * a resolved assessment, never a refusal: it withholds nothing and pushes
 * nothing (the legitimate zero, like the conguaglio's).
 *
 * THE MONEY. Everything is exact decimal (money.ts units or SQL numeric),
 * never JS Number — months and counts are the only Numbers here, and they
 * are not money. Each installment is the remaining assessment over the
 * remaining schedule months, half-up to the cent per amount (the CU
 * istruzioni rule compute-statutory.ts states); the last scheduled month
 * therefore takes exactly the remainder, and a mid-year adopter catches up
 * automatically because nothing was withheld before adoption. Installment
 * factors accumulate beside the advance factors under the same systemKeys,
 * so the December conguaglio's paid side already carries them and its annual
 * side nets the assessment (see itAnnualSettlement) — every euro is
 * attributed to exactly one year's assessment, and recalculation is stable
 * because history reads committed stubs excluding the document being
 * calculated.
 */

type Tx = Pick<typeof db, "execute">;

/** December-settlement factor keys carrying the assessed annuals. */
const DECEMBER_ANNUAL_FACTORS = {
  regionale: "CONG_ADDREG_ANNUAL",
  comunale: "CONG_ADDCOM_ANNUAL",
} as const;

/** Stub factor keys carrying one run's priced saldo installments. */
export const IT_SALDO_INSTALLMENT_FACTORS = {
  regionale: "IT_ADDREG_SALDO",
  comunale: "IT_ADDCOM_SALDO",
} as const;

/**
 * The statutory installment schedules, as remaining-month counts by
 * calendar month of the withholding year's pay date: regionale elevenths
 * January–November, comunale ninths March–November. December settles (the
 * conguaglio moves that month's money), so no month carries installments
 * then; comunale carries none before March.
 */
export function itSaldolInstallmentRemaining(payMonth: number): {
  regionale: number;
  comunale: number;
} {
  if (!Number.isInteger(payMonth) || payMonth < 1 || payMonth > 12) {
    throw new ItPayrollRefusal(
      `IT saldo installments need the pay date's calendar month 1–12, got ${payMonth} — engine defect`,
    );
  }
  return {
    regionale: payMonth <= 11 ? 11 - (payMonth - 1) : 0,
    comunale: payMonth >= 3 && payMonth <= 11 ? 9 - (payMonth - 3) : 0,
  };
}

/** Assessed prior-year balances with the source that proved them. */
export interface ItSurtaxAssessed {
  regionale: string;
  comunale: string;
  source: "december_settlement" | "opening_balances";
}

/**
 * Resolve the assessment year N withholds. December-settlement first (a year
 * OpenBooks itself settled needs no carry-in), the 0393 carry-in row second,
 * refusal by name only when neither exists.
 */
export async function resolveItSurtaxAssessed(
  tx: Tx,
  input: { orgId: string; employeePartyId: string; taxYear: number },
): Promise<ItSurtaxAssessed> {
  const { orgId, employeePartyId, taxYear } = input;
  const priorYear = taxYear - 1;
  const december = (await tx.execute<{ regionale: string | null; comunale: string | null }>(sql`
    select (s.factors->>${DECEMBER_ANNUAL_FACTORS.regionale})::numeric as regionale,
           (s.factors->>${DECEMBER_ANNUAL_FACTORS.comunale})::numeric as comunale
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id
                    and r.document_id = s.pay_run_document_id
                    and r.run_status = 'committed'
      join documents d on d.org_id = r.org_id
                      and d.id = r.document_id
                      and d.status <> 'voided'
     where s.org_id = ${orgId}
       and s.employee_party_id = ${employeePartyId}
       and s.country = 'IT'
       and s.tax_year = ${priorYear}
       and s.factors ? ${DECEMBER_ANNUAL_FACTORS.regionale}
       and s.factors ? ${DECEMBER_ANNUAL_FACTORS.comunale}
     order by s.pay_date desc, s.created_at desc
     limit 1`)).rows[0];
  if (december?.regionale != null && december?.comunale != null) {
    return {
      regionale: String(december.regionale),
      comunale: String(december.comunale),
      source: "december_settlement",
    };
  }
  const carried = (await tx.execute<{ regionale: string | null; comunale: string | null }>(sql`
    select regionale_saldo::text as regionale, comunale_saldo::text as comunale
      from it_addizionali_opening_balances
     where org_id = ${orgId}
       and employee_party_id = ${employeePartyId}
       and tax_year = ${taxYear}
     limit 1`)).rows[0];
  if (carried?.regionale != null && carried?.comunale != null) {
    return {
      regionale: carried.regionale,
      comunale: carried.comunale,
      source: "opening_balances",
    };
  }
  throw new ItPayrollRefusal(
    `IT ${taxYear} addizionali saldo is unassessable for this employee: no committed year ${priorYear} `
    + "December settlement (CONG_ADDREG_ANNUAL) and no it_addizionali_opening_balances row for "
    + `${taxYear} — record the prior-year assessed regionale/comunale in Payroll → Opening balances `
    + "(0.00 when the worker had no prior-year Italian employment), or settle the prior December "
    + "in OpenBooks first",
  );
}

/**
 * One installment: the remaining assessment over the remaining schedule
 * months, half-up to the cent in units. Pure: assessed, withheld and the
 * count arrive resolved, so unit tests drive this with no database.
 *
 * A negative remainder means more was withheld than assessed — two runs
 * moved one month's installment — so it refuses with the duplicate-run
 * remedy instead of pricing a negative withholding. A non-positive count is
 * an engine defect: the caller gates the schedule months first.
 */
export function surtaxSaldoInstallment(
  assessed: string,
  withheldYtd: string,
  remaining: number,
): string {
  if (!Number.isInteger(remaining) || remaining <= 0) {
    throw new ItPayrollRefusal(
      `IT saldo installment needs a positive remaining schedule count, got ${remaining} — engine defect`,
    );
  }
  let remainder: bigint;
  try {
    remainder = toUnits(assessed) - toUnits(withheldYtd);
  } catch {
    throw new ItPayrollRefusal(
      "IT saldo installment prices a non-decimal assessed or withheld figure — engine defect",
    );
  }
  if (remainder < 0n) {
    throw new ItPayrollRefusal(
      `IT saldo installments already exceed the assessed ${assessed} by ${fromUnits(-remainder)} — `
      + "two runs moved one month's installment; void the duplicate run before recalculating",
    );
  }
  if (remainder === 0n) return "0.0000";
  // Half-up to the cent, like every other period figure (the CU istruzioni
  // rule): units are 10^-4, so a cent is 100 units.
  return fromUnits(roundDiv(remainder, BigInt(remaining)));
}

/** Installment history: committed factors this year, and this calendar month. */
export interface ItSurtaxInstallmentHistory {
  regionaleYtd: string;
  comunaleYtd: string;
  regionaleMonth: string;
  comunaleMonth: string;
}

/**
 * What the year already withheld in saldo installments: committed stubs only
 * (a draft must never burn the schedule), excluding the document being
 * calculated (recalculation replaces stubs wholesale, so reading its own
 * factors would price a second layer). One round trip for both surtaxes.
 */
export async function itSurtaxInstallmentHistory(
  tx: Tx,
  input: {
    orgId: string;
    employeePartyId: string;
    taxYear: number;
    payDate: string;
    excludeDocumentId: string;
  },
): Promise<ItSurtaxInstallmentHistory> {
  const { orgId, employeePartyId, taxYear, payDate, excludeDocumentId } = input;
  const monthPrefix = payDate.slice(0, 7);
  const rows = (await tx.execute<{
    regionaleYtd: string | null;
    comunaleYtd: string | null;
    regionaleMonth: string | null;
    comunaleMonth: string | null;
  }>(sql`
    select round(coalesce(sum((s.factors->>${IT_SALDO_INSTALLMENT_FACTORS.regionale})::numeric), 0), 4)::text as "regionaleYtd",
           round(coalesce(sum((s.factors->>${IT_SALDO_INSTALLMENT_FACTORS.comunale})::numeric), 0), 4)::text as "comunaleYtd",
           round(coalesce(sum((s.factors->>${IT_SALDO_INSTALLMENT_FACTORS.regionale})::numeric)
             filter (where to_char(s.pay_date, 'YYYY-MM') = ${monthPrefix}), 0), 4)::text as "regionaleMonth",
           round(coalesce(sum((s.factors->>${IT_SALDO_INSTALLMENT_FACTORS.comunale})::numeric)
             filter (where to_char(s.pay_date, 'YYYY-MM') = ${monthPrefix}), 0), 4)::text as "comunaleMonth"
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id
                    and r.document_id = s.pay_run_document_id
                    and r.run_status = 'committed'
      join documents d on d.org_id = r.org_id
                      and d.id = r.document_id
                      and d.status <> 'voided'
     where s.org_id = ${orgId}
       and s.employee_party_id = ${employeePartyId}
       and s.country = 'IT'
       and s.tax_year = ${taxYear}
       and s.pay_date <= ${payDate}::date
       and s.pay_run_document_id <> ${excludeDocumentId}`)).rows[0];
  return {
    regionaleYtd: rows?.regionaleYtd ?? "0",
    comunaleYtd: rows?.comunaleYtd ?? "0",
    regionaleMonth: rows?.regionaleMonth ?? "0",
    comunaleMonth: rows?.comunaleMonth ?? "0",
  };
}

/** Calendar month of an ISO pay date (months are counts, never money). */
export function itPayMonth(payDate: string | null | undefined, taxYear: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payDate ?? "");
  if (!match) {
    throw new ItPayrollRefusal(
      `IT ${taxYear} saldo installments accrue against the run versement date (run pay_date), `
      + "which the run did not resolve — engine defect",
    );
  }
  return Number(match[2]);
}

/**
 * Price this run's saldo installments and push them as deduction lines under
 * the surtaxes' own systemKeys (the December conguaglio's paid side already
 * carries those keys, and its annual side nets the assessment — see
 * itAnnualSettlement). Returns the installment factors to stamp on the stub.
 *
 * Production entry only: the DB-free monthly core prices the current-year
 * advances, and unit tests drive it with no database. A month already
 * settled by a committed run prices nothing further (one installment per
 * calendar month, however many runs the month holds); a resolved zero
 * assessment prices nothing (the legitimate zero). Anything else pushes.
 */
export async function pushItSurtaxSaldoInstallments(input: {
  tx: Tx;
  orgId: string;
  employeePartyId: string;
  documentId: string;
  taxYear: number;
  payDate: string;
  pushStatutory: PushStatutoryFn;
}): Promise<Record<string, string>> {
  const { tx, orgId, employeePartyId, documentId, taxYear, payDate, pushStatutory } = input;
  const assessed = await resolveItSurtaxAssessed(tx, { orgId, employeePartyId, taxYear });
  const remaining = itSaldolInstallmentRemaining(itPayMonth(payDate, taxYear));
  const history = await itSurtaxInstallmentHistory(tx, {
    orgId, employeePartyId, taxYear, payDate, excludeDocumentId: documentId,
  });
  const factors: Record<string, string> = {};
  const legs = [
    {
      key: IT_SALDO_INSTALLMENT_FACTORS.regionale,
      systemKey: "regional_surtax",
      label: `Addizionale regionale all'IRPEF a saldo ${taxYear - 1} — D.Lgs. 446/1997 art. 50`,
      sequence: 116,
      assessed: assessed.regionale,
      withheldYtd: history.regionaleYtd,
      withheldMonth: history.regionaleMonth,
      remaining: remaining.regionale,
    },
    {
      key: IT_SALDO_INSTALLMENT_FACTORS.comunale,
      systemKey: "municipal_surtax",
      label: `Addizionale comunale all'IRPEF a saldo ${taxYear - 1} — D.Lgs. 360/1998 art. 1`,
      sequence: 121,
      assessed: assessed.comunale,
      withheldYtd: history.comunaleYtd,
      withheldMonth: history.comunaleMonth,
      remaining: remaining.comunale,
    },
  ] as const;
  for (const leg of legs) {
    if (leg.remaining <= 0) continue;
    // One installment per calendar month: a committed run already settled
    // this month, so later runs in the same month price nothing further.
    if (cmp(leg.withheldMonth, "0") !== 0) {
      factors[leg.key] = "0.0000";
      continue;
    }
    const installment = surtaxSaldoInstallment(leg.assessed, leg.withheldYtd, leg.remaining);
    // Half-up to the cent for the line, like every other period figure.
    const cents = fromUnits(roundDiv(toUnits(installment), 100n) * 100n);
    factors[leg.key] = cents;
    if (cmp(cents, "0") === 0) continue;
    // Literal keys: the push-coverage guard enumerates call sites statically,
    // so the leg's key cannot travel through a variable even though both legs
    // are declared components (regional_surtax/municipal_surtax, deduction).
    if (leg.key === IT_SALDO_INSTALLMENT_FACTORS.regionale) {
      pushStatutory("regional_surtax", "deduction", leg.label, cents, leg.sequence);
    } else {
      pushStatutory("municipal_surtax", "deduction", leg.label, cents, leg.sequence);
    }
  }
  return factors;
}
