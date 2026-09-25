import { add, cmp, fromUnits, mulPercent, neg, roundDiv, sum, toUnits } from "../money/money.ts";
import { PayrollPackError } from "./packs.ts";
import type { PayrollEmployerAggregateLevy } from "./packs.ts";

/**
 * Employer-aggregate levies — the generic computation half of the
 * pack-declared `employerAggregateLevies` channel (see `packs.ts`).
 *
 * Everything this module knows comes through the declaration: WHAT the base
 * is (gross or taxable earnings, employer-wide or per-region) and HOW the
 * rate resolves (a published flat percent, marginal bands on the employer
 * total, or a tenant-entered slot value). There is no jurisdiction branch
 * here — an unknown base source or rate kind is refused by name, never
 * approximated.
 *
 * Two doctrines, both inherited from the per-employee levies this channel
 * generalizes:
 *
 * - Room is consumed from COMMITTED history only. The caller folds the
 *   opening carry-in, the committed stub factors, and the already-calculated
 *   stubs of the run being calculated into the priors below (the same
 *   own-document arm the EHT exemption sequences on). Uncommitted runs
 *   consume nothing, so abandoning a draft can never burn annual room.
 * - Bands are MARGINAL. Each slice of base is priced at the band it falls
 *   in, exactly like income-tax brackets, so the annual total does not
 *   depend on where in the calculation order a stub landed and no year-end
 *   true-up is needed. A levy that is flat-on-the-total past a cliff cannot
 *   be expressed per run — that shape is what `timing: "annual"` is for.
 *
 * `timing: "annual"` levies (a spend offset is only knowable at year end)
 * accrue NOTHING here: returning zeros is the guard that stops an annual
 * figure from being dripped onto stubs as though it were owed each payday.
 * Their settlement is a year-end concern, not a per-run one.
 */

/** Factor namespace shape: `CNT`, never `cnt` or `Cnt-7`. */
const FACTOR_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Inputs the generic run layer resolves before calling the assessor. */
export interface AggregateStubPriors {
  /**
   * Employer base already through this levy in scope: the 0174 opening
   * carry-in plus committed stub factors plus the already-calculated stubs
   * of this run. For a per-employee-cap levy this is still the EMPLOYER
   * figure (band position and allowance room for employer-scope levies);
   * the personal figure rides `employeePriorBase`.
   */
  employerPriorBase: string;
  /**
   * This employee's base already through a per-employee-cap levy:
   * the opening carry-in (via the pack's declared opening field) plus
   * committed stub factors plus this run's own-document rows.
   */
  employeePriorBase: string;
  /** Tenant-entered values by slot key (org-scope class flags, spend). */
  tenantValues: Record<string, Record<string, string>>;
  /**
   * Accruing-allowance inputs, resolved per stub by the priors layer: levy
   * already paid in scope, the annual allocated share, and the elapsed tax
   * months. Present exactly when the levy accrues an allowance; the
   * assessor refuses a levy that accrues without them.
   */
  accruing?: {
    priorAmount: string;
    allowanceAnnual: string;
    monthsElapsed: number;
  };
}

/** One stub's share of an aggregate levy. */
export interface AggregateStubAssessment {
  amount: string;
  assessable: string;
  factors: Record<string, string>;
}

const ZERO_ASSESSMENT: AggregateStubAssessment = {
  amount: "0",
  assessable: "0",
  factors: {},
};

/** Every levy in a pack's declaration list, cross-checked. */
export function assertAggregateLeviesValid(
  levies: readonly PayrollEmployerAggregateLevy[],
): void {
  const keys = new Set<string>();
  const factors = new Set<string>();
  for (const levy of levies) {
    assertAggregateLevyValid(levy);
    if (keys.has(levy.key)) {
      throw new PayrollPackError(
        `duplicate employer-aggregate levy key "${levy.key}" — keys are the commit-fence identity`,
      );
    }
    keys.add(levy.key);
    for (const factor of [levy.factorKey, `${levy.factorKey}_EARN`]) {
      if (factors.has(factor)) {
        throw new PayrollPackError(
          `employer-aggregate levy "${levy.key}" reuses factor "${factor}" — `
          + "year-to-date would accumulate two levies into one",
        );
      }
      factors.add(factor);
    }
  }
}

function assertAggregateLevyValid(levy: PayrollEmployerAggregateLevy): void {
  if (!levy.key) {
    throw new PayrollPackError("an employer-aggregate levy declares no key");
  }
  if (!FACTOR_KEY.test(levy.factorKey ?? "")) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" declares factor key "${levy.factorKey ?? ""}" — `
      + "factor keys are uppercase letters, digits and underscores",
    );
  }
  if (!levy.systemKey) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" declares no system key — `
      + "the levy must point at a seeded employer-contribution component",
    );
  }
  if (levy.base?.source !== "gross" && levy.base?.source !== "taxable" && levy.base?.source !== "pensionable") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" declares base source "${levy.base?.source ?? "none"}" — `
      + 'the generic layer accumulates "gross", "taxable" or "pensionable" earnings, nothing else',
    );
  }
  if (levy.base?.source === "pensionable") {
    for (const period of ["weekly", "monthly", "annual"] as const) {
      const floor = levy.base.periodFloor?.[period];
      if (floor === undefined || !/^\d+(\.\d+)?$/.test(floor)) {
        throw new PayrollPackError(
          `employer-aggregate levy "${levy.key}" prices a pensionable base with no ${period} `
          + "period floor — declare the year's weekly, monthly and annual floors",
        );
      }
    }
  }
  if (levy.base?.scope !== "org" && levy.base?.scope !== "region") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" declares base scope "${levy.base?.scope ?? "none"}" — `
      + 'an employer aggregate is "org"-wide or per-"region"',
    );
  }
  if (levy.timing !== "per_run" && levy.timing !== "annual") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" declares timing "${levy.timing ?? "none"}" — `
      + 'a levy is assessed "per_run" or settled "annual"',
    );
  }
  assertRateValid(levy);
  assertAllowanceValid(levy);
  if (levy.offset !== undefined) {
    if (levy.timing !== "annual") {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" pairs a spend offset with per-run assessment — `
        + "spend is only knowable at year end, so an offset levy settles annually",
      );
    }
    if (levy.allowance?.kind !== "employer_allowance") {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" offsets spend against "${levy.allowance?.kind ?? "none"}" — `
        + "a spend offset reduces the base above an employer allowance, nothing else",
      );
    }
    if (!levy.offset.slotKey || !levy.offset.amountField) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" declares a spend offset with no slot or field — `
        + "name the org-scope slot holding the qualifying spend",
      );
    }
  }
  if (levy.excludedBy !== undefined
    && (!levy.excludedBy.slotKey || !levy.excludedBy.flagField)) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" declares an employer exclusion with no slot or flag — `
      + "name the org-scope slot flag holding the exempt class",
    );
  }
  if (levy.timing === "annual" && levy.allowance?.kind === "per_employee_cap") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" settles annually against a per-employee cap — `
      + "a personal cap is enforced stub by stub, per run",
    );
  }
  if (levy.allowance?.kind === "accruing_allowance") {
    if (levy.rate?.kind !== "flat_percent") {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" accrues its allowance at rate kind `
        + `"${(levy.rate as { kind?: unknown } | null | undefined)?.kind ?? "none"}" — `
        + "an accruing allowance prices the cumulative base at a flat percent",
      );
    }
    if (levy.timing !== "per_run") {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" accrues its allowance annually — `
        + "an accruing allowance prices stub by stub against the months elapsed",
      );
    }
    const { yearStartMonth: month, yearStartDay: day } = levy.allowance;
    if (!Number.isInteger(month) || month < 1 || month > 12
      || !Number.isInteger(day) || day < 1 || day > 31) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" accrues from tax-year start ${month}/${day} — `
        + "declare the month 1–12 and the day 1–31 the agency's year opens on",
      );
    }
  }
}

function assertRateValid(levy: PayrollEmployerAggregateLevy): void {
  const { rate } = levy;
  if (rate?.kind === "flat_percent") {
    assertPercent(`employer-aggregate levy "${levy.key}"`, rate.percent);
    return;
  }
  if (rate?.kind === "tenant_slot") {
    if (!rate.slotKey || !rate.percentField) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" reads its rate from a slot with no slot or field — `
        + "name the tenant-entered slot holding the percent",
      );
    }
    return;
  }
  if (rate?.kind === "marginal_bands") {
    if ((rate.bands ?? []).length === 0 && (rate.classBands ?? []).length === 0) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" declares marginal bands with no bands — `
        + "declare at least one band",
      );
    }
    for (const bands of [
      ...(rate.bands ? [rate.bands] : []),
      ...(rate.classBands ?? []).map((entry) => entry.bands),
    ]) {
      assertBands(levy.key, bands.map((band) => ({ upTo: band.upTo, rate: band.percent })));
    }
    for (const entry of rate.classBands ?? []) {
      if (!entry.flag) {
        throw new PayrollPackError(
          `employer-aggregate levy "${levy.key}" declares a class band set with no flag — `
          + "name the employer-class flag selecting it",
        );
      }
    }
    if ((rate.classBands ?? []).length > 0 && !levy.classSlotKey) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" declares class bands with no class slot — `
        + "name the org-scope slot holding the employer-class flags, or the classes can never match",
      );
    }
    return;
  }
  const kind = (rate as { kind?: unknown } | null | undefined)?.kind;
  throw new PayrollPackError(
    `employer-aggregate levy "${levy.key}" declares rate kind "${kind ?? "none"}" — `
    + 'the generic layer resolves "flat_percent", "marginal_bands" or "tenant_slot", nothing else',
  );
}

function assertBands(
  levyKey: string,
  bands: readonly { upTo: string | null; rate: string }[],
): void {
  let floor = "0";
  bands.forEach((band, index) => {
    assertPercent(`employer-aggregate levy "${levyKey}" band ${index + 1}`, band.rate);
    if (band.upTo === null) {
      if (index !== bands.length - 1) {
        throw new PayrollPackError(
          `employer-aggregate levy "${levyKey}" ends a band table mid-table — `
          + "only the top band is open-ended",
        );
      }
      return;
    }
    if (cmp(band.upTo, floor) <= 0) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levyKey}" band ${index + 1} ends at ${band.upTo} — `
        + "band ceilings must rise",
      );
    }
    floor = band.upTo;
  });
  if (bands.length > 0 && bands[bands.length - 1]!.upTo !== null) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levyKey}" has no open top band — `
      + "base above the top ceiling would be priced by nothing; declare the top band open",
    );
  }
}

function assertAllowanceValid(levy: PayrollEmployerAggregateLevy): void {
  const kind = levy.allowance?.kind;
  if (kind === "none") return;
  if (kind === "employer_allowance" || kind === "per_employee_cap") {
    const amount = levy.allowance.amount;
    if (amount === undefined || cmp(amount, "0") < 0) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" declares a negative allowance — `
        + "an allowance is money already sheltered, never less than zero",
      );
    }
    return;
  }
  if (kind === "accruing_allowance") {
    if (!levy.allowance.factKey) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" accrues an allowance with no fact — `
        + "name the subsidiary-scoped employer fact holding the annual allocated share",
      );
    }
    return;
  }
  throw new PayrollPackError(
    `employer-aggregate levy "${levy.key}" declares allowance "${kind ?? "none"}" — `
    + 'an allowance is "none", "employer_allowance", "per_employee_cap" or "accruing_allowance"',
  );
}

function assertPercent(where: string, value: string | undefined): void {
  if (value === undefined || value === "") {
    throw new PayrollPackError(`${where} declares no percent`);
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new PayrollPackError(
      `${where} declares percent "${value}" — a percent is a non-negative number, as the agency states it`,
    );
  }
}

/**
 * One stub's share of one aggregate levy, assessed in calculation order.
 * Pure: every input the answer depends on arrives in `priors`, so the
 * arithmetic is testable without a database and the SQL stays a thin
 * resolver beside the run.
 */
export function assessAggregateLevyStub(
  levy: PayrollEmployerAggregateLevy,
  stubBase: string,
  priors: AggregateStubPriors,
): AggregateStubAssessment {
  // Annual levies settle at year end against the full-year base and the
  // then-known spend. Dripping them onto stubs would print a liability
  // nobody owes yet — so they accrue nothing here, by construction.
  if (levy.timing === "annual") return ZERO_ASSESSMENT;
  if (cmp(stubBase, "0") <= 0) return ZERO_ASSESSMENT;
  assertAggregateLevyValid(levy);
  if (isExcluded(levy, priors)) return ZERO_ASSESSMENT;

  // An accruing allowance prices nothing marginally: the stub pays the
  // cumulative amount due on the whole year-to-date base less what is
  // already paid (HMRC's month-by-month Apprenticeship Levy method), so it
  // branches before the shelter/ceiling slice below.
  if (levy.allowance?.kind === "accruing_allowance") {
    return assessAccruingAllowance(levy, stubBase, priors);
  }
  // A shelter (employer allowance) and a ceiling (per-employee cap) consume
  // room in opposite directions: the shelter prices what lands ABOVE the
  // remaining exempt slice, the ceiling prices what fits BELOW the remaining
  // headroom. Confusing them prices the exempt slice — the exact inversion
  // the threshold unit test pins.
  const prior = levy.allowance?.kind === "per_employee_cap"
    ? priors.employeePriorBase
    : priors.employerPriorBase;
  const { priceFrom, priceBase: priced } = pricedSlice(levy, stubBase, prior);
  // Past a shelter the FULL stub base counts toward the total even when none
  // of it prices: without the stamp, the next stub's room would forget this
  // stub's base and price the sheltered slice twice. Past a ceiling only the
  // priced slice accumulates — base above the cap never prices, ever.
  if (cmp(priced, "0") <= 0) {
    if (levy.allowance?.kind === "employer_allowance") {
      return {
        amount: "0",
        assessable: "0",
        factors: { [levy.factorKey]: "0", [`${levy.factorKey}_EARN`]: stubBase },
      };
    }
    return ZERO_ASSESSMENT;
  }

  const amount = priceBase(levy, priors, priceFrom, priced);
  const earn = levy.allowance?.kind === "employer_allowance" ? stubBase : priced;
  return {
    amount,
    assessable: priced,
    factors: { [levy.factorKey]: amount, [`${levy.factorKey}_EARN`]: earn },
  };
}

/**
 * One stub's share of a levy with an accruing annual allowance: the flat
 * percent of the whole year-to-date base (priors plus this stub) less the
 * allowance accrued to the elapsed tax month less levy already paid, floored
 * at zero. Pure: allowance, months and paid arrive resolved in `priors`.
 *
 * In-run sequencing partitions the month exactly: each stub in calculation
 * order sees the earlier stubs' stamped base and amounts in its priors, so
 * the month's shares sum to the month's liability no matter how the roster
 * splits across stubs.
 */
function assessAccruingAllowance(
  levy: PayrollEmployerAggregateLevy,
  stubBase: string,
  priors: AggregateStubPriors,
): AggregateStubAssessment {
  const accruing = priors.accruing;
  if (!accruing) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" prices an accruing allowance with no resolved `
      + "accrual inputs — engine defect",
    );
  }
  if (levy.rate.kind !== "flat_percent") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" prices an accruing allowance at rate kind `
      + `"${(levy.rate as { kind?: unknown }).kind ?? "none"}" — an accruing allowance prices `
      + "the cumulative base at a flat percent",
    );
  }
  const billIncl = add(priors.employerPriorBase, stubBase);
  const levyPart = mulPercent(billIncl, levy.rate.percent, 2);
  // One twelfth of the annual share per elapsed tax month, half-up to the
  // cent in a single step — never rounded to ledger units first.
  const accrued = fromUnits(
    roundDiv(toUnits(accruing.allowanceAnnual) * BigInt(accruing.monthsElapsed), 1200n) * 100n,
  );
  const due = add(add(levyPart, neg(accrued)), neg(accruing.priorAmount));
  const amount = cmp(due, "0") > 0 ? due : "0";
  // The full stub base stamps toward the total even when the allowance
  // covers this stub: without the stamp the next stub's priors would forget
  // this stub's base and price the sheltered slice twice.
  return {
    amount,
    assessable: stubBase,
    factors: { [levy.factorKey]: amount, [`${levy.factorKey}_EARN`]: stubBase },
  };
}

/**
 * Tax months elapsed in the agency's year at the pay date, from the year's
 * opening month/day: a date on or after the opening day counts its tax
 * month, a date before it belongs to the prior tax month (April 5 is month
 * 12 of the year that opened the previous April 6).
 */
export function taxMonthsElapsed(payDate: string, yearStartMonth: number, yearStartDay: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payDate);
  if (!match) {
    throw new PayrollPackError(`cannot count elapsed tax months for pay date "${payDate}"`);
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  const sinceStart = (month - yearStartMonth + 12) % 12;
  const elapsed = day >= yearStartDay ? sinceStart + 1 : sinceStart || 12;
  if (elapsed < 1 || elapsed > 12) {
    throw new PayrollPackError(`elapsed tax months fell outside 1–12 for pay date "${payDate}" — engine defect`);
  }
  return elapsed;
}

/** The [priceFrom, priceFrom + priced] slice of this stub the levy reaches. */
function pricedSlice(
  levy: PayrollEmployerAggregateLevy,
  stubBase: string,
  prior: string,
): { priceFrom: string; priceBase: string } {
  const { allowance } = levy;
  // Uncapped: the whole stub prices from the current position.
  if (!allowance || allowance.kind === "none") return { priceFrom: prior, priceBase: stubBase };
  if (allowance.kind === "employer_allowance") {
    const priceFrom = cmp(prior, allowance.amount) >= 0 ? prior : allowance.amount;
    const end = add(prior, stubBase);
    return {
      priceFrom,
      priceBase: cmp(end, priceFrom) > 0 ? add(end, neg(priceFrom)) : "0",
    };
  }
  if (allowance.kind === "per_employee_cap") {
    const headroom = cmp(allowance.amount, prior) > 0 ? add(allowance.amount, neg(prior)) : "0";
    return {
      priceFrom: prior,
      priceBase: cmp(stubBase, headroom) <= 0 ? stubBase : headroom,
    };
  }
  // An accruing allowance never prices marginally — assessAggregateLevyStub
  // branches it to the cumulative method before the slice below. Reaching
  // here is an engine defect, refused rather than mispriced.
  throw new PayrollPackError(
    `employer-aggregate levy "${levy.key}" prices allowance kind "${allowance.kind}" marginally — `
    + "engine defect",
  );
}

function isExcluded(
  levy: PayrollEmployerAggregateLevy,
  priors: AggregateStubPriors,
): boolean {
  if (!levy.excludedBy) return false;
  return priors.tenantValues[levy.excludedBy.slotKey]?.[levy.excludedBy.flagField] === "true";
}

/** Price the stub's slice at the bands covering it, or at the flat rate. */
function priceBase(
  levy: PayrollEmployerAggregateLevy,
  priors: AggregateStubPriors,
  position: string,
  assessable: string,
): string {
  const { rate } = levy;
  if (rate.kind === "flat_percent") {
    return mulPercent(assessable, rate.percent, 2);
  }
  if (rate.kind === "tenant_slot") {
    const raw = priors.tenantValues[rate.slotKey]?.[rate.percentField];
    if (raw === undefined || raw === "") {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" reads its rate from slot "${rate.slotKey}" — `
        + "the employer has configured no rate for this year",
      );
    }
    assertPercent(`employer-aggregate levy "${levy.key}" tenant rate`, raw);
    return mulPercent(assessable, raw, 2);
  }
  return priceMarginal(position, assessable, selectBands(levy, priors));
}

function selectBands(
  levy: PayrollEmployerAggregateLevy,
  priors: AggregateStubPriors,
): readonly { upTo: string | null; percent: string }[] {
  const { rate } = levy;
  if (rate.kind !== "marginal_bands") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" has no bands to price from`,
    );
  }
  const matches = (rate.classBands ?? []).filter(
    (entry) => priors.tenantValues[levy.classSlotKey ?? ""]?.[entry.flag] === "true",
  );
  if (matches.length > 1) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" matches ${matches.length} employer classes — `
      + "one employer holds one class for this levy",
    );
  }
  if (matches.length === 1) return matches[0]!.bands;
  if (!rate.bands) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" matches no employer class and declares no default bands — `
      + "refusing to price an unclassifiable employer",
    );
  }
  return rate.bands;
}

/** Walk the marginal bands across [position, position + assessable]. */
function priceMarginal(
  position: string,
  assessable: string,
  bands: readonly { upTo: string | null; percent: string }[],
): string {
  let cursor = position;
  const end = add(position, assessable);
  const slices: string[] = [];
  for (const band of bands) {
    if (cmp(cursor, end) >= 0) break;
    const ceiling = band.upTo ?? end;
    const sliceEnd = cmp(ceiling, end) <= 0 ? ceiling : end;
    if (cmp(sliceEnd, cursor) > 0) {
      slices.push(mulPercent(add(sliceEnd, neg(cursor)), band.percent, 2));
      cursor = sliceEnd;
    }
  }
  if (cmp(cursor, end) < 0) {
    throw new PayrollPackError("marginal band walk left base unpriced");
  }
  return sum(slices);
}
