import { cmp, div, mul } from "../money/money.ts";

/**
 * The cadence a wage is quoted in. A `labor_cost_rates` row stores the rate
 * exactly as the employer quotes it — $32.50 an hour, $1,450 a week, $6,800
 * a month, $88,000 a year — and every consumer converts through this module,
 * so an hourly cost, a salaried pay period and a compensation statement all
 * read one rate the same way.
 *
 * Time-based bases convert through a fixed count of periods per year
 * (52 weeks, 26 fortnights, 24 half-months, 12 months), and to an hourly
 * figure through the row's own `annual_hours`. The counts are the payroll
 * conventions an employment contract quotes against; a pay schedule with a
 * 27th biweekly or 53rd weekly pay date still pays one year's salary, spread
 * over its own number of periods.
 */
export const PAY_RATE_BASES = ["hour", "week", "biweekly", "semimonth", "month", "year"] as const;

export type PayRateBasis = (typeof PAY_RATE_BASES)[number];

/** A basis that quotes pay per stretch of calendar time rather than per hour worked. */
export type TimePayRateBasis = Exclude<PayRateBasis, "hour">;

export const PAY_RATE_BASIS_PERIODS_PER_YEAR: Readonly<Record<TimePayRateBasis, number>> = {
  week: 52,
  biweekly: 26,
  semimonth: 24,
  month: 12,
  year: 1,
};

export function isPayRateBasis(value: unknown): value is PayRateBasis {
  return typeof value === "string" && (PAY_RATE_BASES as readonly string[]).includes(value);
}

/**
 * A basis read back from storage or a caller. Anything outside the declared
 * cadences refuses rather than being converted under a guessed meaning.
 */
export function requirePayRateBasis(value: unknown): PayRateBasis {
  if (!isPayRateBasis(value)) {
    throw new Error(
      `wage basis ${JSON.stringify(value) ?? String(value)} is not a supported pay cadence (${PAY_RATE_BASES.join(", ")})`,
    );
  }
  return value;
}

/**
 * True for a rate quoted per stretch of time. Salaried payroll pays such a
 * rate per period; hourly payroll converts it to an hourly wage.
 */
export function isTimePayRateBasis(basis: PayRateBasis): basis is TimePayRateBasis {
  return basis !== "hour";
}

function requirePositiveHours(annualHours: string): string {
  if (cmp(annualHours, "0") <= 0) {
    throw new Error("annual hours must be greater than zero to convert a pay rate between hourly and time-based terms");
  }
  return annualHours;
}

/** The annual amount a rate pays. An hourly rate needs the annual hours it is worked for. */
export function annualPayRate(rate: string, basis: PayRateBasis, annualHours: string): string {
  if (basis === "hour") return mul(rate, requirePositiveHours(annualHours));
  return mul(rate, String(PAY_RATE_BASIS_PERIODS_PER_YEAR[basis]));
}

/**
 * The hourly equivalent of a rate (4 decimal places). An hourly rate is
 * returned unchanged; a time-based rate is annualized and divided by the
 * row's annual hours, so a yearly rate converts exactly as it always has.
 */
export function hourlyPayRate(rate: string, basis: PayRateBasis, annualHours: string): string {
  if (basis === "hour") return rate;
  return div(annualPayRate(rate, basis, annualHours), requirePositiveHours(annualHours));
}

/** A rate restated in another basis (4 decimal places), through its annual amount. */
export function payRateIn(
  rate: string,
  basis: PayRateBasis,
  target: PayRateBasis,
  annualHours: string,
): string {
  if (basis === target) return rate;
  if (target === "hour") return hourlyPayRate(rate, basis, annualHours);
  return div(annualPayRate(rate, basis, annualHours), String(PAY_RATE_BASIS_PERIODS_PER_YEAR[target]));
}

/**
 * SQL expression for the annual amount of a `labor_cost_rates` row aliased
 * `alias`, the same conversion as `annualPayRate`. Hourly rows annualize
 * through their own annual hours.
 */
export function annualPayRateSqlText(alias: string): string {
  return `(${alias}.rate * case ${alias}.basis
      when 'hour' then ${alias}.annual_hours
      when 'week' then 52 when 'biweekly' then 26 when 'semimonth' then 24
      when 'month' then 12 when 'year' then 1 end)`;
}
