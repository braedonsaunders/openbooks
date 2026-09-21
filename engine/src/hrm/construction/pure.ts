import { HrmConstructionError } from "./errors.ts";

/**
 * Pure construction-compliance decisions (HR-13): scope precedence,
 * reciprocity, per-diem arithmetic, comp-rule matching, ratio evaluation.
 * No DB, no clock — every input arrives as an argument, so these are unit
 * tests without a database and the DB services below are thin loaders.
 */

export interface AppliesTo {
  employer_subsidiary_id?: string | null;
  department_id?: string | null;
  project_ids?: readonly string[] | null;
  location_ids?: readonly string[] | null;
}

export interface ScopeTarget {
  projectId?: string | null;
  locationId?: string | null;
  subsidiaryId?: string | null;
}

/**
 * Scope precedence: project (3) > location (2) > subsidiary (1) > org (0).
 * A schedule with no scope at all is org-wide (0). A schedule whose scope
 * names a project/location/subsidiary that does NOT match the target does
 * not apply (-1) — it loses to every schedule that does, and an empty
 * candidate set is a missing_rate refusal, never a fallback.
 */
export function scopeScore(appliesTo: AppliesTo, target: ScopeTarget): number {
  const scope = appliesTo ?? {};
  const projectIds = scope.project_ids ?? null;
  const locationIds = scope.location_ids ?? null;
  if (projectIds && projectIds.length > 0) {
    if (!target.projectId || !projectIds.includes(target.projectId)) return -1;
    return 3;
  }
  if (locationIds && locationIds.length > 0) {
    if (!target.locationId || !locationIds.includes(target.locationId)) return -1;
    return 2;
  }
  if (scope.employer_subsidiary_id) {
    if (!target.subsidiaryId || scope.employer_subsidiary_id !== target.subsidiaryId) return -1;
    return 1;
  }
  return 0;
}

export type Reciprocity = "home_local" | "jobsite_local" | "higher_of";

export interface RateCandidate {
  base: string;
  fringeCash: string;
  fringeCredit: string;
}

/**
 * Reciprocity between the jobsite line and the worker's home-local line.
 * home_local prices at home, jobsite_local at the jobsite, higher_of at
 * the greater BASE (fringes ride with their own line — the creditable
 * fringe belongs to the plan that was actually paid, never mixed across
 * lines). String decimals compare through a shared parser: financial
 * arithmetic never touches floats.
 */
export function applyReciprocity(
  reciprocity: Reciprocity,
  jobsite: RateCandidate,
  home: RateCandidate | null,
): { line: RateCandidate; source: "home_local" | "jobsite_local" | "higher_of" } {
  if (reciprocity === "home_local") {
    if (!home) {
      throw new HrmConstructionError(
        "The schedule declares home-local reciprocity but the worker has no home-local rate for this classification and date — assign a home schedule with a covering line, or change the schedule's reciprocity.",
      );
    }
    return { line: home, source: "home_local" };
  }
  if (reciprocity === "jobsite_local" || !home) return { line: jobsite, source: "jobsite_local" };
  const cmp = compareDecimal(jobsite.base, home.base);
  if (cmp >= 0) return { line: jobsite, source: "higher_of" };
  return { line: home, source: "higher_of" };
}

export function compareDecimal(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const norm = (i: string, f: string): string => `${i.replace("-", "")}.${(f + "0000").slice(0, 4)}`;
  const an = BigInt(`${a.trim().startsWith("-") ? "-" : ""}${norm(ai!, af).replace(".", "")}`);
  const bn = BigInt(`${b.trim().startsWith("-") ? "-" : ""}${norm(bi!, bf).replace(".", "")}`);
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export type PerDiemBasis = "flat_daily" | "distance_brackets" | "hours_threshold";

export interface DistanceBracket {
  min_km: number;
  max_km: number | null;
  amount: string;
}

/**
 * Per-diem amount for one day from validated rules. Distance policies
 * need distance_km; hours policies need hours; flat needs neither. No
 * match in the brackets is a refusal naming the distance — a bracket set
 * that cannot price a day is not priced at zero.
 */
export function perDiemAmountForDay(
  basis: PerDiemBasis,
  rules: { amount?: string; brackets?: readonly DistanceBracket[]; min_hours?: number; amount_for_hours?: string },
  inputs: { distanceKm?: number | null; hours?: string | null },
): string {
  if (basis === "flat_daily") {
    if (!rules.amount) {
      throw new HrmConstructionError(
        "The flat-daily per-diem policy has no amount in its rules — set an amount on the policy before computing the week.",
      );
    }
    return rules.amount;
  }
  if (basis === "distance_brackets") {
    if (inputs.distanceKm === null || inputs.distanceKm === undefined) {
      throw new HrmConstructionError(
        "The distance-bracket per-diem policy needs the day's distance in kilometres — record the home-base to jobsite distance before computing the week.",
      );
    }
    const hit = (rules.brackets ?? []).find(
      (bracket) =>
        inputs.distanceKm! >= bracket.min_km &&
        (bracket.max_km === null || inputs.distanceKm! <= bracket.max_km),
    );
    if (!hit) {
      throw new HrmConstructionError(
        `No distance bracket covers ${inputs.distanceKm} km — extend the policy's brackets before computing the week.`,
      );
    }
    return hit.amount;
  }
  if (inputs.hours === null || inputs.hours === undefined) {
    throw new HrmConstructionError(
      "The hours-threshold per-diem policy needs the day's approved hours — approve the timesheet before computing the week.",
    );
  }
  if (!rules.min_hours || !rules.amount_for_hours) {
    throw new HrmConstructionError(
      "The hours-threshold per-diem policy has no minimum hours or amount in its rules — set both on the policy before computing the week.",
    );
  }
  return compareDecimal(inputs.hours, String(rules.min_hours)) >= 0 ? rules.amount_for_hours : "0";
}

/** Weekly rule: worked_days present earns paid_days (e.g. 5 worked pays 7). */
export function applyWeeklyRule(
  dailyAmounts: readonly string[],
  weeklyRule: { worked_days: number; paid_days: number } | null,
): readonly string[] {
  if (!weeklyRule) return dailyAmounts;
  const worked = dailyAmounts.filter((amount) => compareDecimal(amount, "0") > 0).length;
  if (worked < weeklyRule.worked_days) return dailyAmounts;
  if (dailyAmounts.length === 0 || weeklyRule.paid_days <= dailyAmounts.length) return dailyAmounts;
  const extra = weeklyRule.paid_days - dailyAmounts.length;
  const last = dailyAmounts[dailyAmounts.length - 1]!;
  return [...dailyAmounts, ...Array<string>(extra).fill(last)];
}

export interface CompMatch {
  project_id?: string | null;
  cost_code_id?: string | null;
  department_id?: string | null;
  classification_id?: string | null;
  state_code?: string | null;
}

export interface CompTarget {
  projectId?: string | null;
  costCodeId?: string | null;
  departmentId?: string | null;
  classificationId?: string | null;
  stateCode?: string | null;
}

/** A rule matches when every match key it names equals the target's. */
export function compRuleMatches(match: CompMatch, target: CompTarget): boolean {
  const pairs: ReadonlyArray<readonly [keyof CompMatch, keyof CompTarget]> = [
    ["project_id", "projectId"],
    ["cost_code_id", "costCodeId"],
    ["department_id", "departmentId"],
    ["classification_id", "classificationId"],
    ["state_code", "stateCode"],
  ];
  return pairs.every(([from, to]) => match[from] == null || match[from] === target[to]);
}

/**
 * Highest-priority match wins; ties break by rule id for determinism. No
 * match is null — the caller refuses with a class_unresolved finding,
 * never a default class.
 */
export function pickCompRule<T extends { id: string; priority: number; match: CompMatch }>(
  rules: readonly T[],
  target: CompTarget,
): T | null {
  const hits = rules.filter((rule) => compRuleMatches(rule.match, target));
  hits.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
  return hits[0] ?? null;
}

/**
 * Apprentice ratio check: apprentice_hours <= journey_hours * (ratioA / ratioJ).
 * Returns the breach (with the journey-priced apprentice hours flag) or
 * null when the day is within ratio. Zero journey hours with any
 * apprentice hour is a breach — an apprentice may not work unsupervised.
 */
export function evaluateRatio(
  journeyHours: string,
  apprenticeHours: string,
  ratioJourney: number,
  ratioApprentice: number,
): { breach: boolean; rateAtJourney: boolean } {
  if (compareDecimal(apprenticeHours, "0") <= 0) return { breach: false, rateAtJourney: false };
  if (compareDecimal(journeyHours, "0") <= 0) return { breach: true, rateAtJourney: true };
  const [jn, jd = ""] = journeyHours.split(".");
  const [an, ad = ""] = apprenticeHours.split(".");
  const jScaled = BigInt(`${jn}${(jd + "0000").slice(0, 4)}`) * BigInt(ratioApprentice);
  const aScaled = BigInt(`${an}${(ad + "0000").slice(0, 4)}`) * BigInt(ratioJourney);
  const breach = aScaled > jScaled;
  return { breach, rateAtJourney: breach };
}
