import { sql } from "drizzle-orm";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { laborFxQuote, resolveWage, type LaborFxQuote } from "../../projects/labor-costing.ts";
import { mul, mulRate } from "../../money/money.ts";
import {
  HrmAuthorizationError,
  loadOwnEmploymentIds,
  requireHrmCompensationManage,
  requireHrmCompensationManageOnEmployment,
  requireHrmCompensationRead,
} from "../authorization.ts";
import { CompensationError } from "./errors.ts";
import { meanAndMedian, fitUnexplainedGap } from "./compensation-math.ts";
import { compensationSettings } from "./architecture.ts";
import { requireActorId, requireId, requireOrgId, requireReason } from "../recruiting/input.ts";

/**
 * Pay transparency (HR-12, 0222): gap snapshots from payroll truth and
 * worker information requests.
 *
 * computeGapSnapshot reads EFFECTIVE RATES from payroll/wage truth
 * (through the wage rate service, never from bands), annualises each
 * from its own versioned wage row (year wages verbatim, hour wages by
 * the row's own annual-hours — never the org's current annualHours),
 * converts every annual to the org reporting currency at the as-of
 * laborFxQuote (refusing by name when a quote is missing, never 1:1),
 * groups by level (the equal-value category), and computes mean and
 * median gaps between the two org-declared comparison groups — a
 * declared party custom-field key from the org's custom fields, never
 * a hardcoded gender field (refuses by name when the attribute is not
 * configured). Variable pay and quartile proportions complete the
 * seven Article 9 metrics; the "unexplained" gap comes from ordinary
 * least squares on tenure, level rank, hours basis and employer
 * subsidiary. Categories whose unexplained gap meets the org's
 * declared threshold (default 5%, configurable) flag joint assessment
 * due. Snapshots are frozen rows carrying the reporting currency and
 * per-currency quote evidence, so later FX or config edits cannot
 * reinterpret them.
 *
 * Pay-information requests: a worker asks for their own category
 * averages (hrm.self.request); fulfilment copies the averages from the
 * latest snapshot covering their category and refuses when none does.
 */

export interface GapCategory {
  readonly levelId: string;
  readonly levelCode: string;
  readonly familyId: string | null;
  readonly countA: number;
  readonly countB: number;
  readonly meanGapPct: number | null;
  readonly medianGapPct: number | null;
  readonly unexplainedGapPct: number | null;
  readonly method: string;
  readonly jointAssessmentDue: boolean;
}

/** Frozen FX evidence for one native currency (the oriented laborFxQuote factor, used once). */
export interface GapFxEvidence {
  readonly rate: string;
  readonly asOf: string;
  readonly source: string;
  readonly inverse: boolean;
}

export interface GapMetrics {
  readonly comparisonAttributeKey: string;
  readonly thresholdPct: number;
  readonly groupA: string;
  readonly groupB: string;
  readonly meanGapPct: number | null;
  readonly medianGapPct: number | null;
  readonly variablePayGapPct: number | null;
  readonly quartileProportions: ReadonlyArray<{ quartile: string; shareA: number; shareB: number }>;
  readonly headcountA: number;
  readonly headcountB: number;
  /** Org reporting currency every rate was converted to. Null only for rows frozen before conversion existed. */
  readonly reportingCurrency: string | null;
  /** Oriented conversion factor per native currency (reporting currency needs none, so it is absent). */
  readonly fxEvidence: Readonly<Record<string, GapFxEvidence>>;
}

/** Stored snake_case metrics document (the 0222 metrics shape CHECK pins comparison_attribute_key and threshold_pct). */
function toStoredMetrics(metrics: GapMetrics): Record<string, unknown> {
  return {
    comparison_attribute_key: metrics.comparisonAttributeKey,
    threshold_pct: metrics.thresholdPct,
    group_a: metrics.groupA,
    group_b: metrics.groupB,
    mean_gap_pct: metrics.meanGapPct,
    median_gap_pct: metrics.medianGapPct,
    variable_pay_gap_pct: metrics.variablePayGapPct,
    quartile_proportions: metrics.quartileProportions.map((q) => ({
      quartile: q.quartile,
      share_a: q.shareA,
      share_b: q.shareB,
    })),
    headcount_a: metrics.headcountA,
    headcount_b: metrics.headcountB,
    reporting_currency: metrics.reportingCurrency,
    fx_evidence: Object.fromEntries(
      Object.entries(metrics.fxEvidence).map(([currency, q]) => [
        currency,
        { rate: q.rate, as_of: q.asOf, source: q.source, inverse: q.inverse },
      ]),
    ),
  };
}

function fromStoredMetrics(stored: Record<string, unknown>): GapMetrics {
  const s = stored as Record<string, unknown>;
  const fxEvidence: Record<string, GapFxEvidence> = {};
  const rawFx = s.fx_evidence;
  if (rawFx !== null && typeof rawFx === "object" && !Array.isArray(rawFx)) {
    for (const [currency, q] of Object.entries(rawFx as Record<string, unknown>)) {
      const e = q as Record<string, unknown>;
      if (e !== null && typeof e === "object") {
        fxEvidence[currency] = {
          rate: String(e.rate),
          asOf: String(e.as_of),
          source: String(e.source),
          inverse: e.inverse === true,
        };
      }
    }
  }
  return {
    comparisonAttributeKey: s.comparison_attribute_key as string,
    thresholdPct: s.threshold_pct as number,
    groupA: s.group_a as string,
    groupB: s.group_b as string,
    meanGapPct: (s.mean_gap_pct ?? null) as number | null,
    medianGapPct: (s.median_gap_pct ?? null) as number | null,
    variablePayGapPct: (s.variable_pay_gap_pct ?? null) as number | null,
    quartileProportions: (s.quartile_proportions as Array<Record<string, unknown>>).map((q) => ({
      quartile: q.quartile as string,
      shareA: q.share_a as number,
      shareB: q.share_b as number,
    })),
    headcountA: s.headcount_a as number,
    headcountB: s.headcount_b as number,
    // Rows frozen before conversion carry neither key: they measured mixed
    // native currencies side by side, so no reporting currency is claimed.
    reportingCurrency:
      typeof s.reporting_currency === "string" && s.reporting_currency.length > 0
        ? (s.reporting_currency as string)
        : null,
    fxEvidence,
  };
}

/** Stored snake_case category rows. */
function toStoredCategories(categories: readonly GapCategory[]): Record<string, unknown>[] {
  return categories.map((c) => ({
    level_id: c.levelId,
    level_code: c.levelCode,
    family_id: c.familyId,
    count_a: c.countA,
    count_b: c.countB,
    mean_gap_pct: c.meanGapPct,
    median_gap_pct: c.medianGapPct,
    unexplained_gap_pct: c.unexplainedGapPct,
    method: c.method,
    joint_assessment_due: c.jointAssessmentDue,
  }));
}

function fromStoredCategories(stored: unknown): GapCategory[] {
  return (stored as Array<Record<string, unknown>>).map((c) => ({
    levelId: c.level_id as string,
    levelCode: c.level_code as string,
    familyId: (c.family_id ?? null) as string | null,
    countA: c.count_a as number,
    countB: c.count_b as number,
    meanGapPct: (c.mean_gap_pct ?? null) as number | null,
    medianGapPct: (c.median_gap_pct ?? null) as number | null,
    unexplainedGapPct: (c.unexplained_gap_pct ?? null) as number | null,
    method: c.method as string,
    jointAssessmentDue: c.joint_assessment_due === true,
  }));
}

export interface GapSnapshotDTO {
  readonly id: string;
  readonly asOf: string;
  readonly metrics: GapMetrics;
  readonly categories: readonly GapCategory[];
  readonly generatedAt: string;
}

/**
 * Org-wide frozen aggregates need an unrestricted actor. A stored
 * snapshot aggregates every in-scope worker at its as-of date into
 * immutable means, medians, quartiles and regressions that cannot be
 * post-filtered back down to one subsidiary — so any subsidiary
 * restriction (a list, even one covering every subsidiary today, or an
 * empty set) fails closed. The check is `allowed !== null` on the
 * canonical lens, never a subset comparison, for two reasons. The
 * frozen row carries no population-evidence list: it proves its
 * statistics, not which subsidiaries its subjects belonged to, so a
 * current enumeration cannot prove it covered exactly the actor's
 * list at its historical as-of date. And a list that covers today
 * still misses tomorrow's subsidiary.
 */
function gapScopeRefusal(verb: "compute" | "read" | "fulfil"): CompensationError {
  const permission = verb === "read" ? "hrm.compensation.read" : "hrm.compensation.manage";
  return new CompensationError(
    "REFUSED",
    `pay-gap snapshots measure the whole organization — a role restricted to specific subsidiaries (or to none) cannot ${verb} an org-wide frozen aggregate without seeing every worker it covers, and frozen aggregates cannot be post-filtered. Ask an administrator to grant ${permission} with access to all subsidiaries (no subsidiary restriction) to ${verb} gap snapshots.`,
  );
}

async function requireUnrestrictedGapScope(
  orgId: string,
  actorId: string,
  verb: "compute" | "read" | "fulfil",
): Promise<void> {
  const allowed = await actorAllowedSubsidiaryIds(db, orgId, actorId);
  if (allowed !== null) throw gapScopeRefusal(verb);
}

/** Unknown, cross-org, and out-of-scope pay-information requests share one message. */
function payRequestNotVisible(): CompensationError {
  return new CompensationError(
    "NOT_FOUND",
    "pay information request is not visible in this organization and legal-entity scope.",
  );
}

interface PricedWorker {
  employmentId: string;
  workerPartyId: string;
  levelId: string;
  levelCode: string;
  levelRank: number;
  familyId: string | null;
  annualRate: number;
  currency: string;
  group: string;
  tenureYears: number;
  hoursBasis: number;
  employerSubsidiaryId: string;
}

/** Read one party custom-field value for the comparison attribute. Refuses by name when unconfigured. */
async function comparisonGroupFor(
  orgId: string,
  attributeKey: string,
  workerPartyId: string,
): Promise<string | null> {
  const row = (await db.execute<{ value: string | null }>(sql`
    select custom->>${attributeKey} as value
      from parties where org_id = ${orgId} and id = ${workerPartyId}`)).rows[0];
  if (row === undefined) return null;
  const value = row.value;
  if (value === null || value === undefined || String(value).trim().length === 0) return null;
  return String(value);
}

function gapPct(a: number, b: number): number | null {
  if (!(b > 0)) return null;
  return ((a - b) / b) * 100;
}

export async function computeGapSnapshot(query: {
  orgId: string;
  actorId: string;
  asOf: string;
  groupA: string;
  groupB: string;
}): Promise<GapSnapshotDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.asOf)) {
    throw new CompensationError("INVALID_INPUT", "asOf (YYYY-MM-DD) required");
  }
  if (!query.groupA || !query.groupB || query.groupA === query.groupB) {
    throw new CompensationError(
      "INVALID_INPUT",
      "two distinct comparison group values are required — name both sides of the comparison explicitly",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    // Org-wide aggregate: a restricted lens must never silently compute
    // a partial-org snapshot and present it as whole-org.
    await requireUnrestrictedGapScope(orgId, actorId, "compute");
    const settings = await compensationSettings(orgId);
    const attributeKey = settings.comparisonAttributeKey;
    if (attributeKey === null) {
      throw new CompensationError(
        "REFUSED",
        "no comparison attribute is configured — declare the party custom field naming the two comparison groups in compensation settings before measuring gaps",
      );
    }
    // In-service employments with an architected position level at asOf.
    const employments = (await db.execute<{
      employment_id: string;
      worker_party_id: string;
      employer_subsidiary_id: string;
      position_id: string | null;
      started_on: string | null;
    }>(sql`
      select e.id as employment_id, e.worker_party_id, e.employer_subsidiary_id,
             aav.position_id,
             (select min(effective_from)::text from worker_employment_versions
               where org_id = e.org_id and employment_id = e.id) as started_on
        from worker_employments e
        join worker_employment_versions ev
          on ev.org_id = e.org_id and ev.employment_id = e.id
         and ev.effective_from <= ${query.asOf}::date
         and (ev.effective_to is null or ev.effective_to >= ${query.asOf}::date)
         and ev.recorded_until is null
        left join employment_assignment_versions aav
          on aav.org_id = e.org_id and aav.employment_id = e.id and aav.is_primary
         and aav.effective_from <= ${query.asOf}::date
         and (aav.effective_to is null or aav.effective_to >= ${query.asOf}::date)
         and aav.recorded_until is null
       where e.org_id = ${orgId} and ev.status in ('active', 'on_leave')`)).rows;
    // Every rate is converted to the org's reporting currency before it
    // enters any mean, median, quartile or regression — native amounts in
    // different currencies never sit side by side.
    const orgRow = (await db.execute<{ base_currency: string | null }>(sql`
      select base_currency from orgs where id = ${orgId}`)).rows[0];
    const reportingCurrency = orgRow?.base_currency?.trim() || null;
    if (!reportingCurrency) {
      throw new CompensationError(
        "REFUSED",
        "no reporting currency is set — set the org base currency before measuring gaps, so every wage converts to one declared basis",
      );
    }
    // Absence (never fetched) is undefined; a fetched miss stays cached
    // null and refuses below — never 1:1, never omitted.
    const quoteCache = new Map<string, LaborFxQuote | null>();
    const fxEvidence: Record<string, GapFxEvidence> = {};
    const priced: PricedWorker[] = [];
    for (const employment of employments) {
      if (!employment.position_id) continue;
      const position = (await db.execute<{
        level_id: string | null;
      }>(sql`
        select job_level_id as level_id from position_versions
         where org_id = ${orgId} and position_id = ${employment.position_id}
           and effective_from <= ${query.asOf}::date
           and (effective_to is null or effective_to >= ${query.asOf}::date)
           and recorded_until is null
         order by effective_from desc limit 1`)).rows[0];
      if (!position?.level_id) continue;
      const level = (await db.execute<{
        code: string;
        rank: number;
        family_id: string | null;
      }>(sql`
        select code, rank, family_id from hrm_job_levels
         where org_id = ${orgId} and id = ${position.level_id} and is_active`)).rows[0];
      if (!level) continue;
      // Payroll truth: the effective wage through the wage rate service.
      const wage = await resolveWage(orgId, employment.worker_party_id, query.asOf, {
        subsidiaryId: employment.employer_subsidiary_id,
      });
      if (!wage) continue;
      const group = await comparisonGroupFor(orgId, attributeKey, employment.worker_party_id);
      if (group !== query.groupA && group !== query.groupB) continue;
      // Native annualization from the versioned wage row itself — a year
      // wage already IS its annual (used verbatim, never divided and
      // re-multiplied), an hour wage annualises with the row's own
      // annual-hours. The org's current annualHours never enters: it is
      // config, and config edits must not reinterpret a worker's annual.
      const rateRow = (await db.execute<{ rate: string; basis: string; annual_hours: string }>(sql`
        select rate::text as rate, basis, annual_hours::text as annual_hours
          from labor_cost_rates where org_id = ${orgId} and id = ${wage.rateId}`)).rows[0];
      if (!rateRow) {
        throw new CompensationError(
          "STALE_REVISION",
          "a wage rate moved while the snapshot was computed — rerun the snapshot; nothing was saved",
        );
      }
      let nativeAnnual: string;
      if (rateRow.basis === "year") {
        nativeAnnual = rateRow.rate;
      } else if (rateRow.basis === "hour") {
        nativeAnnual = mul(rateRow.rate, rateRow.annual_hours);
      } else {
        throw new CompensationError(
          "REFUSED",
          `wage basis ${JSON.stringify(rateRow.basis)} is not hour or year — correct the labor cost rate before measuring gaps`,
        );
      }
      const nativeHours = Number(rateRow.annual_hours);
      if (!Number.isFinite(nativeHours) || !(nativeHours > 0)) {
        throw new CompensationError(
          "REFUSED",
          "a wage annual-hours is not a positive finite number — correct the labor cost rate before measuring gaps",
        );
      }
      // Convert to the reporting currency with the as-of spot quote,
      // oriented once. Same-currency needs no quote; a missing quote
      // refuses by name — never 1:1, never omitted.
      let convertedAnnual: string;
      if (wage.currency === reportingCurrency) {
        convertedAnnual = nativeAnnual;
      } else {
        let quote: LaborFxQuote | null | undefined = quoteCache.get(wage.currency);
        if (quote === undefined) {
          quote = await laborFxQuote(orgId, wage.currency, reportingCurrency, query.asOf);
          quoteCache.set(wage.currency, quote);
        }
        if (!quote) {
          throw new CompensationError(
            "REFUSED",
            `cannot measure: no spot rate for ${wage.currency}→${reportingCurrency} on or before ${query.asOf} — add an FX spot rate covering the snapshot date, then compute the snapshot again; unconfigured currencies never convert at 1:1`,
          );
        }
        convertedAnnual = mulRate(nativeAnnual, quote.rate);
        fxEvidence[wage.currency] = { rate: quote.rate, asOf: quote.asOf, source: quote.source, inverse: quote.inverse };
      }
      const annualRate = Number(convertedAnnual);
      if (!Number.isFinite(annualRate)) {
        throw new CompensationError(
          "REFUSED",
          `the converted annual rate ${JSON.stringify(convertedAnnual)} ${reportingCurrency} is not finite — refuse the amount, never coerce it`,
        );
      }
      const started = employment.started_on === null ? query.asOf : String(employment.started_on).slice(0, 10);
      const tenureYears = Math.max(
        0,
        (Date.parse(`${query.asOf}T00:00:00Z`) - Date.parse(`${started}T00:00:00Z`)) / 365.25 / 86400000,
      );
      priced.push({
        employmentId: employment.employment_id,
        workerPartyId: employment.worker_party_id,
        levelId: position.level_id,
        levelCode: level.code,
        levelRank: level.rank,
        familyId: level.family_id,
        annualRate,
        currency: reportingCurrency,
        group,
        tenureYears,
        hoursBasis: nativeHours,
        employerSubsidiaryId: employment.employer_subsidiary_id,
      });
    }
    if (priced.length === 0) {
      throw new CompensationError(
        "REFUSED",
        "no priced worker falls in both comparison groups — the snapshot would measure nothing; check band coverage, wages and the declared attribute",
      );
    }
    const inA = priced.filter((p) => p.group === query.groupA).map((p) => p.annualRate);
    const inB = priced.filter((p) => p.group === query.groupB).map((p) => p.annualRate);
    if (inA.length === 0 || inB.length === 0) {
      throw new CompensationError(
        "REFUSED",
        `only one side of the comparison has priced workers (${inA.length} vs ${inB.length}) — a gap needs both sides; check the declared attribute values`,
      );
    }
    const overallA = meanAndMedian(inA, "group rates");
    const overallB = meanAndMedian(inB, "group rates");
    // Quartile proportions across the whole measured population.
    const sorted = [...priced].sort((a, b) => a.annualRate - b.annualRate);
    const quartileProportions = [0, 1, 2, 3].map((q) => {
      const slice = sorted.slice(Math.floor((q * sorted.length) / 4), Math.floor(((q + 1) * sorted.length) / 4));
      const a = slice.filter((p) => p.group === query.groupA).length;
      const b = slice.filter((p) => p.group === query.groupB).length;
      const total = a + b;
      return {
        quartile: `q${q + 1}`,
        shareA: total === 0 ? 0 : a / total,
        shareB: total === 0 ? 0 : b / total,
      };
    });
    // Per-category rows: level is the equal-value category.
    const byLevel = new Map<string, PricedWorker[]>();
    for (const p of priced) {
      const list = byLevel.get(p.levelId) ?? [];
      list.push(p);
      byLevel.set(p.levelId, list);
    }
    const subsidiaryIndex = new Map<string, number>();
    for (const p of priced) {
      if (!subsidiaryIndex.has(p.employerSubsidiaryId)) subsidiaryIndex.set(p.employerSubsidiaryId, subsidiaryIndex.size);
    }
    const categories: GapCategory[] = [];
    for (const [levelId, members] of byLevel) {
      const a = members.filter((p) => p.group === query.groupA).map((p) => p.annualRate);
      const b = members.filter((p) => p.group === query.groupB).map((p) => p.annualRate);
      const first = members[0]!;
      let meanGap: number | null = null;
      let medianGap: number | null = null;
      let unexplained: number | null = null;
      let method = "insufficient_data";
      if (a.length > 0 && b.length > 0) {
        const ma = meanAndMedian(a, "category rates");
        const mb = meanAndMedian(b, "category rates");
        meanGap = gapPct(ma.mean, mb.mean);
        medianGap = gapPct(ma.median, mb.median);
        // Unexplained gap: the group coefficient with tenure, rank,
        // hours and subsidiary partialled out (constant columns drop
        // before fitting, so single-level categories still resolve).
        const fitted = fitUnexplainedGap(
          members.map((p) => ({
            groupIsA: p.group === query.groupA,
            tenureYears: p.tenureYears,
            levelRank: p.levelRank,
            hoursBasis: p.hoursBasis,
            subsidiaryIdx: subsidiaryIndex.get(p.employerSubsidiaryId) ?? 0,
            logRate: Math.log(p.annualRate),
          })),
        );
        unexplained = fitted.unexplainedGapPct;
        method = fitted.method;
      }
      categories.push({
        levelId,
        levelCode: first.levelCode,
        familyId: first.familyId,
        countA: a.length,
        countB: b.length,
        meanGapPct: meanGap,
        medianGapPct: medianGap,
        unexplainedGapPct: unexplained,
        method,
        jointAssessmentDue: unexplained !== null && Math.abs(unexplained) >= settings.gapThresholdPct,
      });
    }
    categories.sort((x, y) => (x.levelCode < y.levelCode ? -1 : 1));
    const metrics: GapMetrics = {
      comparisonAttributeKey: attributeKey,
      thresholdPct: settings.gapThresholdPct,
      groupA: query.groupA,
      groupB: query.groupB,
      meanGapPct: gapPct(overallA.mean, overallB.mean),
      medianGapPct: gapPct(overallA.median, overallB.median),
      // Variable pay is not yet separated from base in payroll truth:
      // the metric is present and null rather than silently zero, so a
      // reader never mistakes "unmeasured" for "no gap".
      variablePayGapPct: null,
      quartileProportions,
      headcountA: inA.length,
      headcountB: inB.length,
      reportingCurrency,
      fxEvidence,
    };
    const inserted = (await db.execute<{ id: string; generated_at: string }>(sql`
      insert into hrm_pay_gap_snapshots (org_id, as_of, scope, metrics, categories, generated_by, created_by, updated_by)
      values (${orgId}, ${query.asOf},
              ${JSON.stringify({ employer_subsidiary_id: null, department_id: null })}::jsonb,
              ${JSON.stringify(toStoredMetrics(metrics))}::jsonb, ${JSON.stringify(toStoredCategories(categories))}::jsonb,
              ${actorId}, ${actorId}, ${actorId})
      returning id, generated_at::text as generated_at`)).rows[0];
    if (!inserted) throw new CompensationError("REFUSED", "the snapshot insert matched no row — the save is refused, never a silent success");
    return {
      id: inserted.id,
      asOf: query.asOf,
      metrics,
      categories,
      generatedAt: inserted.generated_at,
    };
  });
}

export async function latestGapSnapshot(query: {
  orgId: string;
  actorId: string;
}): Promise<GapSnapshotDTO | null> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  await requireHrmCompensationRead(db, orgId, actorId);
  // Frozen org-wide aggregates cannot be post-filtered: a restricted
  // lens reads nothing, never a partial view presented as whole-org.
  await requireUnrestrictedGapScope(orgId, actorId, "read");
  const row = (await db.execute<{
    id: string;
    as_of: string;
    metrics: Record<string, unknown>;
    categories: unknown;
    generated_at: string;
  }>(sql`
    select id, as_of::text as as_of, metrics, categories, generated_at::text as generated_at
      from hrm_pay_gap_snapshots
     where org_id = ${orgId}
     order by as_of desc, generated_at desc
     limit 1`)).rows[0];
  if (!row) return null;
  return { id: row.id, asOf: row.as_of, metrics: fromStoredMetrics(row.metrics), categories: fromStoredCategories(row.categories), generatedAt: row.generated_at };
}

export interface PayInformationRequestDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly fulfilledAt: string | null;
  readonly responseSnapshotId: string | null;
  readonly status: "open" | "fulfilled" | "refused";
  readonly categoryAverages: Record<string, unknown> | null;
}

/** A worker requests their own category averages. Due = requested + the declared response days. */
export async function requestPayInformation(query: {
  orgId: string;
  actorId: string;
  employmentId: string;
}): Promise<PayInformationRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  return withOrgTransaction(orgId, async () => {
    // Identity first (unknown and foreign employments share this refusal,
    // so the difference is never observable), then the explicit domain
    // grant: identity alone files nothing.
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    if (!own.includes(employmentId)) {
      throw new CompensationError(
        "REFUSED",
        "pay information requests cover your own employment — HR answers anyone else's through the equity surface",
      );
    }
    if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.request"))) {
      throw new HrmAuthorizationError(
        "Pay-information requests file only with the hrm.self.request permission — ask an administrator to grant it in /admin/roles.",
      );
    }
    const settings = await compensationSettings(orgId);
    if (settings.responseDays === null) {
      throw new CompensationError(
        "REFUSED",
        "no response window is configured — declare the pay-information response days in compensation settings before the first request",
      );
    }
    const inserted = (await db.execute<{
      id: string;
      requested_at: string;
      due_at: string;
    }>(sql`
      insert into hrm_pay_information_requests (org_id, employment_id, due_at, created_by, updated_by)
      values (${orgId}, ${employmentId}, now() + (${settings.responseDays} || ' days')::interval, ${actorId}, ${actorId})
      returning id, requested_at::text as requested_at, due_at::text as due_at`)).rows[0];
    if (!inserted) throw new CompensationError("REFUSED", "the request insert matched no row — the save is refused, never a silent success");
    return {
      id: inserted.id,
      employmentId,
      requestedAt: inserted.requested_at,
      dueAt: inserted.due_at,
      fulfilledAt: null,
      responseSnapshotId: null,
      status: "open" as const,
      categoryAverages: null,
    };
  });
}

/** Fulfil a request from the latest snapshot covering the worker's category. Refuses when none does. */
export async function fulfilPayInformationRequest(query: {
  orgId: string;
  actorId: string;
  requestId: string;
}): Promise<PayInformationRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  return withOrgTransaction(orgId, async () => {
    // The manage grant first (one uniform refusal for every request id
    // when it is missing), then the source row, then the
    // employer-subsidiary lens — all before the snapshot read and the
    // fulfil write, so a refused fulfil leaves zero rows and missing,
    // foreign, and hidden ids stay identical.
    await requireHrmCompensationManage(db, orgId, actorId);
    const request = (await db.execute<{
      id: string;
      employment_id: string;
      status: string;
    }>(sql`
      select id, employment_id, status from hrm_pay_information_requests
       where org_id = ${orgId} and id = ${requestId} for update`)).rows[0];
    // Unknown, cross-org, and out-of-scope requests share one refusal —
    // the target-employment lens runs before any state or snapshot read,
    // so a refused fulfil answers nothing and writes nothing.
    if (!request) throw payRequestNotVisible();
    try {
      await requireHrmCompensationManageOnEmployment(db, orgId, actorId, request.employment_id);
    } catch (e) {
      if (e instanceof HrmAuthorizationError) throw payRequestNotVisible();
      throw e;
    }
    if (request.status !== "open") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${request.status} request cannot be fulfilled — only open requests fulfil`,
      );
    }
    // Fulfilment copies org-wide frozen category averages: a restricted
    // lens must not launder them through a request it was refused directly.
    await requireUnrestrictedGapScope(orgId, actorId, "fulfil");
    // The worker's level category at the snapshot date.
    const snapshot = (await db.execute<{
      id: string;
      categories: unknown;
    }>(sql`
      select id, categories from hrm_pay_gap_snapshots
       where org_id = ${orgId}
       order by as_of desc, generated_at desc limit 1`)).rows[0];
    if (!snapshot) {
      throw new CompensationError(
        "REFUSED",
        "no gap snapshot exists — compute a snapshot before answering pay-information requests",
      );
    }
    const today = await businessToday(orgId);
    const position = (await db.execute<{ level_id: string | null }>(sql`
      select pv.job_level_id as level_id
        from employment_assignment_versions aav
        join position_versions pv
          on pv.org_id = aav.org_id and pv.position_id = aav.position_id
         and pv.effective_from <= ${today}::date
         and (pv.effective_to is null or pv.effective_to >= ${today}::date)
         and pv.recorded_until is null
       where aav.org_id = ${orgId} and aav.employment_id = ${request.employment_id} and aav.is_primary
         and aav.effective_from <= ${today}::date
         and (aav.effective_to is null or aav.effective_to >= ${today}::date)
         and aav.recorded_until is null
         and aav.position_id is not null
       order by aav.effective_from desc limit 1`)).rows[0];
    const category = position?.level_id
      ? fromStoredCategories(snapshot.categories).find((c) => c.levelId === position.level_id) ?? null
      : null;
    if (!category) {
      throw new CompensationError(
        "REFUSED",
        "no snapshot covers this worker's category — compute a snapshot including their level before answering",
      );
    }
    const averages = {
      snapshotId: snapshot.id,
      levelCode: category.levelCode,
      countA: category.countA,
      countB: category.countB,
      meanGapPct: category.meanGapPct,
      medianGapPct: category.medianGapPct,
    };
    const updated = (await db.execute<{
      requested_at: string;
      due_at: string;
      fulfilled_at: string;
    }>(sql`
      update hrm_pay_information_requests
         set status = 'fulfilled', fulfilled_at = now(), response_snapshot_id = ${snapshot.id},
             reason = ${JSON.stringify(averages)}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'open'
       returning requested_at::text as requested_at, due_at::text as due_at,
                 fulfilled_at::text as fulfilled_at`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the request moved while it was fulfilled — reload it and fulfil again");
    }
    return {
      id: requestId,
      employmentId: request.employment_id,
      requestedAt: updated.requested_at,
      dueAt: updated.due_at,
      fulfilledAt: updated.fulfilled_at,
      responseSnapshotId: snapshot.id,
      status: "fulfilled" as const,
      categoryAverages: averages,
    };
  });
}

/** Refuse a request with its reason (the worker reads the reason). */
export async function refusePayInformationRequest(query: {
  orgId: string;
  actorId: string;
  requestId: string;
  reason: string;
}): Promise<PayInformationRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    // The manage grant first, then the source row (uniform not-found),
    // then the employer-subsidiary lens — all before the guarded update,
    // so a refused refuse writes nothing and missing, foreign, and hidden
    // ids stay identical; only an in-scope non-open request reports state.
    await requireHrmCompensationManage(db, orgId, actorId);
    const source = (await db.execute<{ employment_id: string }>(sql`
      select employment_id from hrm_pay_information_requests
       where org_id = ${orgId} and id = ${requestId} for update`)).rows[0];
    if (!source) throw payRequestNotVisible();
    try {
      await requireHrmCompensationManageOnEmployment(db, orgId, actorId, source.employment_id);
    } catch (e) {
      if (e instanceof HrmAuthorizationError) throw payRequestNotVisible();
      throw e;
    }
    const updated = (await db.execute<{
      employment_id: string;
      requested_at: string;
      due_at: string;
      fulfilled_at: string;
    }>(sql`
      update hrm_pay_information_requests
         set status = 'refused', fulfilled_at = now(), reason = ${reason}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'open'
       returning employment_id, requested_at::text as requested_at, due_at::text as due_at,
                 fulfilled_at::text as fulfilled_at`)).rows[0];
    if (!updated) {
      throw new CompensationError(
        "BAD_STATE",
        "the request is not open — only open requests refuse",
      );
    }
    return {
      id: requestId,
      employmentId: updated.employment_id,
      requestedAt: updated.requested_at,
      dueAt: updated.due_at,
      fulfilledAt: updated.fulfilled_at,
      responseSnapshotId: null,
      status: "refused" as const,
      categoryAverages: null,
    };
  });
}
