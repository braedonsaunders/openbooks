import { fromUnits, roundDiv, sum, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type {
  PayrollEmployerLevyContext,
  PayrollEmployerLevyFactors,
} from "../statutory-context.ts";
import { EMPTY_EMPLOYER_LEVY_FACTORS } from "../statutory-context.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";
import { AU_PACK_RATES } from "./rates.ts";
import { AU_SUPER_2027 } from "./tax-year-2027.ts";

/**
 * Phase 8 — the AU pack's earnings-assessed employer levy: workers'
 * compensation.
 *
 * Each state's insurer sets the employer's premium rate (a tenant-entered
 * regional fraction such as 0.012 for 1.2% — see `au_workers_comp` in
 * ./rates.ts, kind "rate", NOT a percent). Rateable remuneration includes
 * employer superannuation contributions (WorkSafe Victoria, "How remuneration
 * works", "Superannuation contributions", https://www.worksafe.vic.gov.au/how-remuneration-works).
 * Include the SG amount generated
 * from this stub's OTE alongside its gross wages. Linear in the
 * base, so per-stub assessment sums to the employer's liability exactly and
 * the per-employee channel (this hook) prices identically to an aggregate
 * one — no `employerAggregateLevies` declaration needed.
 *
 * Unconfigured stays inert (the slot's `legacy` answer): readiness keeps
 * warning "nothing is being accrued" until a rate resolves for the stub's
 * region. A resolving rate accrues here, so the warning clears only when
 * the money actually moves.
 */

const RATE_SCALE = 1_000_000n;
const CENTS_PER_UNIT = 100n;

function rateUnits(rate: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(rate)) {
    throw new PayrollPackError(
      `AU workers' compensation rate "${rate}" is not a decimal fraction — `
      + "enter the premium rate from the state insurer's notice (0.027 for 2.7%)",
    );
  }
  const [whole = "0", fraction = ""] = rate.split(".");
  return BigInt(whole) * RATE_SCALE + BigInt((fraction + "000000").slice(0, 6));
}

/**
 * The pure half: assessable wages × the state's premium fraction, rounded
 * once half-up to the cent. The rounding is single — gross straight to
 * cents in integer units — because rounding to ledger precision first and
 * then to cents double-rounds products whose fourth decimal sits on a
 * half-cent boundary.
 */
export function assessAuWorkersComp(
  gross: string,
  rate: string,
  pensionable: string,
): { amount: string; assessable: string } {
  const units = rateUnits(rate);
  if (units > RATE_SCALE) {
    throw new PayrollPackError(
      `AU workers' compensation rate "${rate}" exceeds 1 (100%) — `
      + "correct the au_workers_comp rate for the state instead of pricing it",
    );
  }
  const earnings = toUnits(gross);
  const ote = toUnits(pensionable);
  if (earnings < 0n || ote < 0n) {
    throw new PayrollPackError("AU workers' compensation gross and OTE bases must be non-negative");
  }
  // Match the pack's SG computation: 12% of OTE, rounded half-up to cents.
  const superCents = roundDiv(
    ote * rateUnits(AU_SUPER_2027.chargeRate), RATE_SCALE * CENTS_PER_UNIT,
  );
  const assessableUnits = earnings + superCents * CENTS_PER_UNIT;
  const cents = roundDiv(assessableUnits * units, RATE_SCALE * CENTS_PER_UNIT);
  return {
    amount: fromUnits(cents * CENTS_PER_UNIT),
    assessable: fromUnits(assessableUnits),
  };
}

export async function applyAuEmployerLevies(
  ctx: PayrollEmployerLevyContext,
): Promise<PayrollEmployerLevyFactors> {
  const { orgId, taxYear, region, lines, pushStatutory } = ctx;
  const resolution = await resolveStatutoryRates(orgId, AU_PACK_RATES, taxYear);
  const rate = resolution.values("au_workers_comp", { region })?.rate ?? null;
  // Legacy slot: no rate for this region accrues nothing, and readiness
  // says so by name until one resolves.
  if (rate == null || rate === "") return { ...EMPTY_EMPLOYER_LEVY_FACTORS };
  const gross = sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));
  if (toUnits(gross) <= 0n) return { ...EMPTY_EMPLOYER_LEVY_FACTORS };
  const pensionable = sum(lines
    .filter((line) => line.kind === "earning" && !line.accrualOnly && (line.pensionable ?? true))
    .map((line) => line.amount));
  const { amount, assessable } = assessAuWorkersComp(gross, rate, pensionable);
  pushStatutory("wcb", "employer_contribution", "Workers' compensation", amount, 260);
  return { ...EMPTY_EMPLOYER_LEVY_FACTORS, wcbAmount: amount, wcbAssessable: assessable };
}
