import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { analyticsConfig } from "./config";
import type { ConfigValuesOf } from "./config-spec";
import { flowRates, MissingExchangeRateError, presentationCurrency, type FlowRates } from "../fx-presentation";
import { add, cmp, mulDecimal, sum } from "@openbooks/engine/money";
import { ForbiddenError, type Authz } from "../authz";
import { sentinelAccessDenied } from "./sentinel-access";
import { auditEventArgs, type ConformityCode, type SentinelStrings, sentinelStrings } from "./sentinel-strings";
import { RISK_SCORING } from "./sentinel-scoring";
export { RISK_SCORING, type RiskScoreRule, type RiskScoringSection } from "./sentinel-scoring";
import { addCalendarDays, addMonthsClamped, calendarDaysBetween } from "@openbooks/engine/src/platform/business-date.ts";
import { englishCatalogMessage } from "./catalog-strings";

/**
 * Sentinel — transaction integrity forensics re-engineered for scale.
 *
 * Every forensic test runs as set-based SQL over the full ledger — window functions for
 * per-vendor baselines (RSF, z-score), gaps-and-islands for sequential
 * invoice runs, set-based self-join for duplicates, GROUP BY digit for
 * Benford — so any period over any dataset size returns aggregates, with
 * only the top-N detail rows per detector shipped to the client.
 *
 * Money doctrine: every statistical test runs per document currency.
 * Consolidated money (meta, summary, calendar, vendor roll-up, trap/weekend
 * totals, duplicate value at risk) aggregates per (functional currency, date)
 * in SQL and translates each bucket at its document-date spot through
 * flowRates — the same flow doctrine vendor performance and spend velocity
 * use. Sums use the exact bigint kernel and ship as canonical decimal
 * strings; per-document display amounts stay in their transaction currency.
 * A JavaScript number never carries money across this module's boundary.
 *
 * Threshold doctrine: every detection cut-off (risk tiers, floors, windows,
 * baselines, bands, sample minima) is an organization threshold from the
 * analytics spec. Risk tiers compare translated amounts; the RSF and
 * z-score statistics (rank, mean, σ, multiples, deviations) run on
 * document-currency amounts, and only their noise gates read presentation
 * money. The scoring POINTS below are the
 * product's fixed severity model, not business facts: they decide how loud a
 * finding is, never whether it flags.
 */

// The fixed severity model lives in ./sentinel-scoring (client-safe, so the
// gauge and tiles read the same bands the scorer reads).

const SPEND_KINDS = ["vendor_bill", "vendor_credit", "vendor_payment", "check", "expense_report", "journal", "customer_credit"] as const;

/**
 * An amount tier the organization configured: its threshold with the
 * severity model's points. An unset tier (empty threshold) is null — never
 * zero points, so scorers skip it and the score names the exclusion.
 */
interface SetTier { threshold: string; points: number }
const setTier = (rule: { points?: number }, threshold: string): SetTier | null =>
  (threshold === "" || rule.points === undefined ? null : { threshold, points: rule.points });

/**
 * First configured rung at or under the amount, in priority order. Empty
 * tiers skip their points: awarding against an unset figure would mean
 * different money per currency, and skipped tiers are named in the score's
 * exclusion note. `strict` keeps the aggregate ladders' above-threshold
 * semantics; document ladders award at the threshold.
 */
const ladderBump = (
  total: string,
  rungs: ReadonlyArray<{ rule: { points?: number }; threshold: string }>,
  strict = false,
): number => {
  for (const rung of rungs) {
    const set = setTier(rung.rule, rung.threshold);
    if (set !== null && (strict ? cmp(total, set.threshold) > 0 : cmp(total, set.threshold) >= 0)) return set.points;
  }
  return 0;
};

// Mean Absolute Deviation conformity bands from Benford's Law
// (Mark Nigrini, 2012): first-digit 0.006 / 0.012 / 0.015
// (close / acceptable / marginal; above nonconforming) and first-two-digit
// 0.0012 / 0.0018 / 0.0022. Expected frequencies are mathematics
// (log10(1 + 1/d)).
const BENFORD_1D: Record<number, number> = {
  1: 0.30103, 2: 0.17609, 3: 0.12494, 4: 0.09691, 5: 0.07918, 6: 0.06695, 7: 0.05799, 8: 0.05115, 9: 0.04576,
};

/** Benford conformity as a stable code — never translated text, so forensic
 * payloads (and the client's severity switches) compare against the same
 * value in every language. `insufficient` means the slice never scored. */
export const benfordConformity1D = (mad: number): ConformityCode =>
  (mad <= 0.006 ? "excellent" : mad <= 0.012 ? "acceptable" : mad <= 0.015 ? "marginal" : "nonConforming");
export const benfordConformity2D = (mad: number): ConformityCode =>
  (mad <= 0.0012 ? "excellent" : mad <= 0.0018 ? "acceptable" : mad <= 0.0022 ? "marginal" : "nonConforming");

/**
 * Per-digit Z-statistic from Benford's Law (Mark Nigrini, 2012): whether one
 * digit's observed share deviates significantly from its Benford
 * expectation, with the continuity correction. Published standard — a fixed
 * 25%/50% deviation band cannot tell a real deviation from small-sample
 * noise. Z above 1.96 flags.
 */
export function benfordDigitZ(observed: number, expected: number, n: number): number {
  if (!(n > 0) || !(expected > 0) || !(expected < 1)) return 0;
  const corrected = Math.abs(observed - expected) - 1 / (2 * n);
  if (corrected <= 0) return 0;
  return corrected / Math.sqrt((expected * (1 - expected)) / n);
}

/** Return the inclusive start of the vendor-statistics baseline window. The
 * window length always comes from configuration (baselineMonths) — never a
 * hardcoded default here. */
export function sentinelBaselineFrom(to: string, months: number): string {
  return addMonthsClamped(to, -months);
}

export interface FlowAmountLimit {
  subjectKind: string;
  /** Exact decimal text of the authored comparison value. */
  limit: string;
}

type LogicRuleLeaf = { op: string; field?: string; value?: unknown; rules?: LogicRuleLeaf[]; rule?: LogicRuleLeaf };

/**
 * Latest spot rate from a row's functional currency to presentation on or
 * before the row's date — the same selection flowRates makes in TypeScript
 * (direct quotes win ties, inverse otherwise, 1 when identical). NULL when
 * uncovered: every caller pairs this with assertFloorCoverage, so an
 * uncovered row refuses by name instead of dropping silently or pricing at
 * zero. `func` and `date` are SQL fragments over the caller's row.
 */
function spotRateSql(func: SQL, date: SQL, pres: string, org: string): SQL {
  return sql`(select s.rate from (
    select rate, as_of, 0 as priority from fx_rates
     where org_id = ${org} and from_currency = ${func}
       and to_currency = ${pres} and rate_type = 'spot' and as_of <= ${date}::date
    union all
    select (1 / rate)::numeric(19,10), as_of, 1 as priority from fx_rates
     where org_id = ${org} and from_currency = ${pres}
       and to_currency = ${func} and rate_type = 'spot' and as_of <= ${date}::date
  ) s order by s.as_of desc, s.priority asc limit 1)`;
}

/**
 * Fail closed before a translated floor comparison: every functional
 * currency in the scan scope must have spot coverage on or before its own
 * earliest row, or flowRates throws the named missing-rate refusal. Without
 * this, the NULL lateral rate would silently drop rows from the detector.
 */
async function assertFloorCoverage(
  orgId: string,
  pres: string,
  scope: SQL,
): Promise<void> {
  const funcs = await db.execute<{ func: string; mind: string }>(sql`
    select coalesce(s.base_currency, ${pres}) as func,
           min(coalesce(d.document_date, d.posting_date))::text as mind
      from documents d
      left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
     where ${scope}
     group by 1
  `);
  await flowRates(
    orgId,
    funcs.rows.map((r) => ({ func: r.func, date: r.mind })),
  );
}

/**
 * Candidate approval limits from the org's enabled Flows: every numeric
 * `total` comparison value in a condition node, per subject kind. A flow
 * condition reads the document's own total, so each limit is denominated in
 * whatever transaction currency the document under test carries — detection
 * compares amounts to limits in the same currency and never translates
 * either side. Non-positive and unreadable values are not limits. Only
 * spend subjects are collected: a limit on any other subject kind can never
 * gate a spend document.
 */
export function extractFlowAmountLimits(
  flows: ReadonlyArray<{ subjectKind: string; graph: unknown }>,
): FlowAmountLimit[] {
  const out: FlowAmountLimit[] = [];
  const seen = new Set<string>();
  const visit = (subjectKind: string, node: LogicRuleLeaf | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.rules)) {
      for (const child of node.rules) visit(subjectKind, child);
      return;
    }
    if (node.rule && typeof node.rule === "object") {
      visit(subjectKind, node.rule);
      return;
    }
    if (
      (node.op === "gt" || node.op === "gte" || node.op === "lt" || node.op === "lte" || node.op === "eq") &&
      node.field === "total"
    ) {
      const raw = typeof node.value === "number" ? String(node.value) : typeof node.value === "string" ? node.value.trim() : "";
      if (/^\d+(\.\d+)?$/.test(raw) && /[1-9]/.test(raw)) {
        const key = `${subjectKind}|${raw}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ subjectKind, limit: raw });
        }
      }
    }
  };
  for (const flow of flows) {
    // Only spend subjects can gate a spend document: a limit on any other
    // subject kind can never trip the threshold-trap detector, so counting
    // it would report the detector configured when it is not.
    if (!(SPEND_KINDS as readonly string[]).includes(flow.subjectKind)) continue;
    const graph = flow.graph as { nodes?: Array<{ data?: { kind?: string; rule?: LogicRuleLeaf } }> } | null;
    const nodes = Array.isArray(graph?.nodes) ? graph!.nodes! : [];
    for (const node of nodes) {
      if (node?.data?.kind === "condition") visit(flow.subjectKind, node.data.rule);
    }
  }
  out.sort((a, b) => (a.subjectKind < b.subjectKind ? -1 : a.subjectKind > b.subjectKind ? 1 : cmp(a.limit, b.limit)));
  return out;
}

// ---- shapes (money travels as exact decimal strings, never numbers) --------

export interface FlaggedDoc {
  docId: string;
  docNumber: string;
  kind: string;
  date: string;
  /** Transaction amount, exact, in the document's own currency. */
  amount: string;
  /** Document (transaction) currency — detection evidence stays denominated. */
  currency: string;
  /** Translated into the presentation currency at the document-date spot. */
  funcAmount: string;
  partyId: string | null;
  partyName: string;
  flagType: "duplicate" | "weekend" | "rsf" | "zscore" | "trap" | "sequential";
  reason: string;
  riskScore: number;
}

export interface DuplicateMember {
  docId: string; docNumber: string; reference: string; date: string;
  amount: string; currency: string; funcAmount: string; memo: string | null;
}

/** ONE finding per natural-key group: (party, kind, currency, amount, reference). */
export interface DuplicateGroup {
  groupId: string;
  partyId: string | null; partyName: string;
  kind: string; currency: string;
  amount: string; funcTotal: string;
  count: number; dateSpanDays: number; firstDate: string; lastDate: string;
  sameReference: boolean; confidence: number; riskScore: number;
  members: DuplicateMember[];
}

export interface DuplicatePair {
  docId1: string; docId2: string; docNumber1: string; docNumber2: string;
  kind: string; date1: string; date2: string; daysBetween: number;
  amount: string; currency: string; partyId: string | null; partyName: string;
  sameMemo: boolean; confidence: number; riskScore: number;
}

export interface BenfordDigit {
  digit: number;
  count: number;
  /** Exact transaction-currency sum behind the digit, in the slice currency. */
  amount: string;
  observed: number;
  expected: number;
  deviationPct: number;
  isAnomaly: boolean;
}

export interface SequentialGroup {
  partyId: string; partyName: string; count: number; totalAmount: string;
  currency: string;
  startRef: number; endRef: number; dateSpanDays: number;
  firstDate: string; lastDate: string;
  riskLevel: "high" | "medium"; riskScore: number; reason: string;
  invoices: { docId: string; docNumber: string; reference: string; date: string; amount: string; currency: string; funcAmount: string }[];
}

/** One Benford distribution for a single document currency. */
export interface BenfordCurrencySlice {
  currency: string;
  totalTransactions: number;
  digits: BenfordDigit[];
  mad: number;
  conformity: string;
  message: string;
  anomalies: BenfordDigit[];
}

export interface GhostVendor {
  vendorId: string; vendorName: string; employeeId: string; employeeName: string;
  matchType: "name" | "address" | "name+address"; riskScore: number; reason: string;
}

export interface AuditEvent {
  id: string; tableName: string; rowId: string; action: string; actorId: string | null;
  /** Raw instant. */
  at: string;
  /** Wall time in the org's time zone, for display. */
  displayAt: string;
  summary: string;
}

export type SentinelConfig = ConfigValuesOf<"sentinel">;

export interface SentinelData {
  /** The severity model, shipped so Configuration renders it read-only
   * from this object — never from restated prose. */
  scoring: typeof RISK_SCORING;
  period: { from: string; to: string; label: string };
  meta: { totalDocs: number; totalAmount: string; presentationCurrency: string; days: number; queryMs: number };
  config: SentinelConfig;
  summary: {
    flaggedCount: number;
    duplicateCount: number;
    totalDuplicateAmount: string;
    weekendCount: number;
    weekendAmount: string;
    rsfCount: number;
    zScoreCount: number;
    sequentialGroups: number;
    ghostCount: number;
    trapCount: number;
    totalAtRisk: string;
    overallRiskScore: number;
    benfordConformity: string;
    benford2DConformity: string;
    approvalLimitRisk: boolean;
    topRiskAreas: { area: string; severity: "critical" | "high" | "medium"; count: number; message: string }[];
    /** Translated names of skipped Configuration-governed scoring sources (unset floors/tiers). */
    excludedDetectors: string[];
  };
  duplicates: {
    total: number;
    pairs: DuplicatePair[];
    groups: DuplicateGroup[];
    /** Null when the duplicate floor is not configured. */
    unavailable: string | null;
  };
  benford1D: { totalTransactions: number; digits: BenfordDigit[]; mad: number; conformity: string; message: string; byCurrency: BenfordCurrencySlice[] };
  benford2D: { totalTransactions: number; digits: BenfordDigit[]; anomalies: BenfordDigit[]; mad: number; conformity: string; byCurrency: BenfordCurrencySlice[] };
  thresholdTrap: { total: number; totalAmount: string; byTrap: { trap: string; count: number; amount: string }[]; items: FlaggedDoc[]; unavailable: string | null };
  weekend: { total: number; totalAmount: string; saturday: number; sunday: number; items: FlaggedDoc[] };
  rsf: { total: number; items: (FlaggedDoc & { rsf: number; secondLargest: string; baselineCount: number })[]; unavailable: string | null };
  zscore: { total: number; items: (FlaggedDoc & { zScore: number; vendorAvg: string; vendorStdDev: string; baselineCount: number })[]; unavailable: string | null };
  sequential: SequentialGroup[];
  ghosts: GhostVendor[];
  auditTrail: { total: number; deletes: number; sensitiveChanges: number; events: AuditEvent[] };
  flagged: FlaggedDoc[];
  vendorRisk: { partyId: string | null; partyName: string; flagCount: number; totalAmount: string; flagTypes: string[]; maxRiskScore: number; compositeScore: number }[];
  calendar: { date: string; count: number; amount: string }[];
}

interface AggregateRow extends Record<string, string | number | null> {
  count: string | number;
  amount: string | number;
  /** Exact transaction-currency sum for the group, as selected (`txn_amount`). */
  txn_amount: string | number;
}
interface FlaggedDocumentRow extends Record<string, unknown> {
  id: string; document_number: string | null; kind: string; date: string; amount: string;
  currency: string; func_amount: string; func: string;
  party_id: string | null; party_name: string | null; trap?: string; dow?: string | number;
}
/** One natural-key group row with its member documents as JSON. */
interface DuplicateGroupRow extends Record<string, unknown> {
  party_id: string | null; party_name: string; kind: string; currency: string;
  amt: string; refkey: string; cnt: string | number;
  first_date: string; last_date: string; span_days: string | number;
  members: Array<{
    docId: string; docNumber: string | null; reference: string; date: string;
    amount: string; currency: string; funcAmount: string; funcCcy: string; memo: string | null;
  }>;
}
interface VendorStatisticRow extends FlaggedDocumentRow {
  rsf?: string | number; z?: string | number; second_amount: string;
  baseline_count: string | number; avg_amount: string; std_amount: string;
  full_count?: string | number;
}
interface SequentialRow extends Record<string, unknown> {
  party_id: string; party_name: string; span_days: string | number; cnt: string | number;
  currency: string;
  start_ref: string | number; end_ref: string | number;
  first_date: string; last_date: string;
  full_count?: string | number;
  invoices: Array<{ docId: string; docNumber: string; reference: string; date: string; amount: string; currency: string; funcAmount: string; funcCcy: string }>;
}
interface GhostRow extends Record<string, unknown> {
  vendor_id: string; vendor_name: string; employee_id: string; employee_name: string;
  name_match: boolean; address_match: boolean;
  full_count?: string | number;
}
interface AuditRow extends Record<string, unknown> {
  id: string; table_name: string; row_id: string; action: string; actor_id: string | null;
  at: string; display_at: string; changes: string | null;
}
/** Slim full-coverage id rows: every detector names each flagged document once. */
interface FlaggedIdRow extends Record<string, unknown> {
  doc_id: string; func_amount: string; func: string; date: string;
}

// ---- main -------------------------------------------------------------------

export async function sentinelData(
  orgId: string,
  period: { from: string; to: string; label: string },
  authz: Authz,
  strings: SentinelStrings = sentinelStrings(englishCatalogMessage, "en"),
): Promise<SentinelData> {
  // Whole-company forensics includes cross-entity baselines, identity matches
  // and retained administrative audit snapshots. Partial access cannot be
  // represented by silently dropping evidence or returning zero-risk counts.
  if (!authz || authz.user.orgId !== orgId) {
    throw new ForbiddenError("unrestricted reports and audit access");
  }
  const denied = sentinelAccessDenied(authz);
  if (denied !== null) {
    throw new ForbiddenError(denied);
  }
  const { from, to } = period;
  const t0 = Date.now();
  const kindsIn = sql.join(SPEND_KINDS.map((k) => sql`${k}`), sql`, `);
  const cfg = await analyticsConfig(orgId, "sentinel");
  const DUPLICATE_THRESHOLD_DAYS = cfg.duplicateDays;
  // An unset duplicate floor refuses the whole duplicate detector by name:
  // comparing against an invented figure would mean different money per
  // currency. The duplicate widget reads the same flag.
  const duplicateFloor = cfg.duplicateMinAmount === "" ? null : (cfg.duplicateMinAmount as string);
  // An unset RSF or z-score floor excludes the whole detector by name: a
  // noise gate without a figure cannot tell dust from signal. Tiers work the
  // same way per comparison below — empty tiers skip their points.
  const rsfFloor = cfg.rsfBaselineFloor === "" ? null : (cfg.rsfBaselineFloor as string);
  const zscoreFloor = cfg.zscoreSigmaFloor === "" ? null : (cfg.zscoreSigmaFloor as string);
  // A duplicate pair must fall within the threshold of each other, so a
  // candidate further outside the window than that can never join to one
  // inside it. Widening the candidate scan by exactly the threshold is
  // equivalent and keeps the self-join off the whole document history.
  // (Computed here rather than as `${from}::date - ${days}` — an untyped bind
  // parameter on the right of a date subtraction does not resolve.)
  const DUPLICATE_SCAN_FROM = addCalendarDays(from, -DUPLICATE_THRESHOLD_DAYS);
  const DUPLICATE_SCAN_TO = addCalendarDays(to, DUPLICATE_THRESHOLD_DAYS);
  const SEQUENTIAL_MIN = cfg.sequentialMinCount;
  const SEQUENTIAL_MIN_DAYS_FOR_FLAG = cfg.sequentialMinDays;

  // Baseline window for vendor statistics, from configuration.
  const end = new Date(to + "T00:00:00Z");
  const baselineFrom = sentinelBaselineFrom(to, cfg.baselineMonths);
  // Consolidated money label: the org base the translations land in.
  const presentationCcy = await presentationCurrency(orgId);

  // Approval limits from the org's enabled Flows: condition nodes comparing
  // `total`, per subject kind. No amount condition anywhere means the
  // threshold-trap detector is unavailable by name — never "risk: Yes".
  const flowRows = await db.execute<{ subject_kind: string; graph: unknown }>(sql`
    select subject_kind, graph from flows where org_id = ${orgId} and enabled
  `);
  const flowLimits = extractFlowAmountLimits(
    flowRows.rows.map((r) => ({ subjectKind: r.subject_kind, graph: r.graph })),
  );
  const limitsByKind: Record<string, string[]> = {};
  for (const { subjectKind, limit } of flowLimits) {
    (limitsByKind[subjectKind] ??= []).push(limit);
  }
  const trapBand = cfg.trapBandPercent;

  // Audit-trail window in the org's own time zone: day bounds are wall
  // midnight in the org zone, converted to instants for the comparison, so a
  // deletion near local midnight lands on the org's calendar day.
  const timeZoneRow = await db.execute<{ tz: string | null }>(sql`
    select settings ->> 'timeZone' as tz from orgs where id = ${orgId}
  `);
  const auditZone = timeZoneRow.rows[0]?.tz?.trim() ? timeZoneRow.rows[0]!.tz!.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: auditZone });
  } catch {
    throw new Error(`organization time zone "${auditZone}" is not valid — fix it in Company Settings`);
  }

  // Shared filter: non-voided spend documents in the period with a readable
  // amount — at least one hundred minor units in the document's own
  // currency, derived from currencies.minor_units. For two-decimal
  // currencies this is the historical one-major-unit gate bit for bit;
  // yen-scale and three-decimal currencies stop assuming two decimals.
  // func is the posting subsidiary's functional currency (root-owned lines
  // read the org base); func_amt carries the first translation leg at ledger
  // precision, and flowRates completes the second leg per (func, date). The
  // currency row feeds the per-currency trap signature; lims carries the
  // Flows approval limits the trap band reads. Used only by the aggregate
  // scan below.
  const periodDocs = sql`
    from documents d
    left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
    left join currencies cu on cu.code = d.currency,
    lateral (select ${JSON.stringify(limitsByKind)}::jsonb as lims) as lims
    where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
      and coalesce(d.document_date, d.posting_date) >= ${from}
      and coalesce(d.document_date, d.posting_date) <= ${to}
      and abs(coalesce(d.total, 0)) * power(10, coalesce(cu.minor_units, 2)) >= 100`;

  // Translated floor comparisons refuse by name before scanning: every
  // functional currency in the duplicate window must have spot coverage, or
  // the NULL lateral rate would silently drop candidates. Single-currency
  // scopes resolve to 1 with no rate rows and never throw here.
  if (duplicateFloor !== null) {
    await assertFloorCoverage(
      orgId,
      presentationCcy,
      sql`d.org_id = ${orgId} and d.voided_at is null
        and d.kind in ('vendor_bill', 'check', 'expense_report', 'vendor_payment')
        and d.party_id is not null
        and coalesce(d.document_date, d.posting_date) >= ${DUPLICATE_SCAN_FROM}
        and coalesce(d.document_date, d.posting_date) <= ${DUPLICATE_SCAN_TO}`,
    );
  }
  // The statistics baseline reaches further back than any other scan. A
  // missing historic rate must not refuse all of Sentinel, so this probe
  // runs only while a statistics floor is set — and missing coverage marks
  // only the statistics detectors unavailable by name instead of throwing.
  let statsSpotRefusal: string | null = null;
  if (rsfFloor !== null || zscoreFloor !== null) {
    try {
      await assertFloorCoverage(
        orgId,
        presentationCcy,
        sql`d.org_id = ${orgId} and d.voided_at is null
          and d.kind in (${kindsIn})
          and d.party_id is not null
          and coalesce(d.document_date, d.posting_date) >= ${baselineFrom}
          and coalesce(d.document_date, d.posting_date) <= ${to}`,
      );
    } catch (error) {
      if (error instanceof MissingExchangeRateError) {
        statsSpotRefusal = strings.spotRateMissing(error.message);
      } else {
        throw error;
      }
    }
  }

  const [
    aggRows, trapRows, dupAll, weekendDetail, weekendIds,
    vendorStatRows, seqDetail, seqIds, ghostRows, auditRows, auditAgg,
  ] = await Promise.all([
    // Six aggregates over the same row set in ONE scan (GROUPING SETS):
    // dataset meta, per-currency Benford 1D/2D, the threshold-trap split, the
    // weekend split — plus the translation buckets (func, date) that every
    // consolidated total is translated from. Trap/weekend qualify a subset,
    // so their key is NULL for non-qualifying rows and that null group is
    // dropped below. Benford sets carry the document currency (one
    // distribution per currency, never blended) with exact transaction sums;
    // every other money sum is the first-leg translation, completed into the
    // presentation currency bucket by bucket below.
    (db.execute(sql`
      with base as (
        select coalesce(s.base_currency, ${presentationCcy}) as func,
               d.currency as cur,
               abs(d.total) as txn_amt,
               round(abs(d.total) * d.fx_rate, 4) as func_amt,
               coalesce(d.document_date, d.posting_date) as ddate,
               left(trunc(abs(d.total))::bigint::text, 1) as digit1,
               case when abs(d.total) >= 10 then left(trunc(abs(d.total))::bigint::text, 2)
                    else left(trunc(abs(d.total) * 10)::bigint::text, 2) end as digit2,
               case when trunc(abs(d.total))::bigint % 100 = 99
                    and round((abs(d.total) - trunc(abs(d.total))) * power(10, coalesce(cu.minor_units, 2)))
                        in (0, power(10, coalesce(cu.minor_units, 2)) - 1)
                    and exists (
                      select 1 from jsonb_array_elements_text(coalesce(lims.lims -> d.kind, '[]'::jsonb)) as lim
                      where abs(d.total) >= lim::numeric * (1 - (${trapBand}::numeric / 100))
                        and abs(d.total) < lim::numeric
                    )
                    then case when trunc(abs(d.total))::bigint % 10000 = 9999 then '9999'
                              when trunc(abs(d.total))::bigint % 1000 = 999 then '999'
                              else '99' end end as trap,
               case when extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
                    then extract(dow from coalesce(d.document_date, d.posting_date))::int end as dow
        ${periodDocs}
      )
      select grouping(func) as g_func,
             grouping(cur) as g_cur,
             grouping(digit1) as g_digit1, grouping(digit2) as g_digit2,
             grouping(trap) as g_trap, grouping(dow) as g_dow, grouping(ddate) as g_date,
             func, cur, digit1, digit2, trap, dow, ddate::text as date,
             count(*) as count, coalesce(sum(func_amt), 0)::text as amount,
             coalesce(sum(txn_amt), 0)::text as txn_amount
        from base
       group by grouping sets ((), (cur, digit1), (cur, digit2), (trap), (dow),
                               (func, ddate), (trap, func, ddate), (dow, func, ddate))
    `)),

    // Threshold-trap rows: the 99-signature (per-currency minor units) AND a
    // configured band below a real Flows limit for the document's kind. Rows
    // outside every band never reach the client; with no limits at all the
    // predicate is empty and the detector reports unavailable.
    (db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total)::text as amount, d.currency as currency,
        round(abs(d.total) * d.fx_rate, 4)::text as func_amount,
        coalesce(s.base_currency, ${presentationCcy}) as func,
        d.party_id, coalesce(p.display_name, '') as party_name,
        case when trunc(abs(d.total))::bigint % 10000 = 9999 then '9999'
             when trunc(abs(d.total))::bigint % 1000 = 999 then '999'
             else '99' end as trap
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
      left join currencies c on c.code = d.currency,
      lateral (select ${JSON.stringify(limitsByKind)}::jsonb as lims) as lims
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        -- Same minor-unit dust gate as the shared filter above.
        and abs(coalesce(d.total, 0)) * power(10, coalesce(c.minor_units, 2)) >= 100
        and trunc(abs(d.total))::bigint % 100 = 99
        and round((abs(d.total) - trunc(abs(d.total))) * power(10, coalesce(c.minor_units, 2)))
            in (0, power(10, coalesce(c.minor_units, 2)) - 1)
        and exists (
          select 1 from jsonb_array_elements_text(coalesce(lims.lims -> d.kind, '[]'::jsonb)) as lim
          where abs(d.total) >= lim::numeric * (1 - (${trapBand}::numeric / 100))
            and abs(d.total) < lim::numeric
        )
      order by abs(d.total) desc
      limit 100
    `)),

    // Duplicates, or the named refusal when the floor is not configured. The
    // candidate set (payable documents at or above the floor) materializes
    // ONCE, then groups by the natural key — party, kind, document currency,
    // abs-amount and normalized vendor reference — keeping only groups of 2+
    // whose date span fits the duplicate window. Currency in the key kills the
    // cross-currency false positive; the reference in the key keeps recurring
    // same-amount invoices with distinct references out. Each group reports
    // ONE finding with every member listed. Four legs share the qualified
    // set: the top groups for display (cut by count and span — exact and
    // currency-blind — then re-sorted by translated value below), the full
    // group count, the excess-copy buckets every value-at-risk figure is
    // translated from, and the one anchor document per group that joins the
    // flagged union.
    (duplicateFloor === null
      ? Promise.resolve({ rows: [] as DuplicateGroupRow[] })
      : db.execute(sql`
      with cand as materialized (
        -- pres_amt translates each candidate into presentation money at its
        -- own document-date spot (total × fx_rate × func→presentation), so
        -- the floor below compares translated money with translated money.
        -- Uncovered currencies refuse up front (assertFloorCoverage); a NULL
        -- rate here is unreachable, never a silent drop.
        select *, round(abs(total) * fx_rate * pres_rate, 4) as pres_amt from (
          select id, document_number, kind, party_id, memo, reference_number, currency, fx_rate,
                 abs(total) as amt, round(abs(total) * fx_rate, 4) as func_amt,
                 coalesce(s.base_currency, ${presentationCcy}) as func_ccy,
                 coalesce(document_date, posting_date) as ddate,
                 case when coalesce(s.base_currency, ${presentationCcy}) = ${presentationCcy} then 1
                      else ${spotRateSql(sql`coalesce(s.base_currency, ${presentationCcy})`, sql`coalesce(d.document_date, d.posting_date)`, presentationCcy, orgId)} end as pres_rate
            from documents d
            left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
           where org_id = ${orgId} and voided_at is null
             and kind in ('vendor_bill', 'check', 'expense_report', 'vendor_payment')
             and party_id is not null
             and coalesce(document_date, posting_date) >= ${DUPLICATE_SCAN_FROM}
             and coalesce(document_date, posting_date) <= ${DUPLICATE_SCAN_TO}
        ) base
      ), keyed as (
        select *, lower(trim(coalesce(reference_number, ''))) as refkey from cand
         where pres_amt >= ${duplicateFloor}::numeric
      ), grouped as materialized (
        select party_id, kind, currency, amt, refkey,
          count(*) as cnt, min(ddate) as first_date, max(ddate) as last_date,
          (max(ddate) - min(ddate)) as span_days,
          jsonb_agg(jsonb_build_object('docId', id, 'docNumber', document_number,
            'reference', coalesce(reference_number, ''), 'date', ddate::text,
            'amount', amt::text, 'currency', currency, 'funcAmount', func_amt::text,
            'funcCcy', func_ccy, 'memo', memo) order by ddate, id) as members
        from keyed
        group by party_id, kind, currency, amt, refkey
        having count(*) >= 2 and (max(ddate) - min(ddate)) <= ${DUPLICATE_THRESHOLD_DAYS}
      ), qualified as materialized (
        select * from grouped
        where (first_date between ${from} and ${to} or last_date between ${from} and ${to})
      ), top as (
        select * from qualified order by cnt desc, span_days asc, party_id, kind, currency, amt, refkey limit 50
      ), ranked_members as (
        select q.party_id, q.kind, q.currency, q.amt, q.refkey,
          (m.m->>'docId') as doc_id, (m.m->>'funcAmount') as func_amt,
          (m.m->>'funcCcy') as func_ccy, (m.m->>'date') as ddate,
          row_number() over (partition by q.party_id, q.kind, q.currency, q.amt, q.refkey
                             order by (m.m->>'funcAmount')::numeric desc) as rn_amt,
          row_number() over (partition by q.party_id, q.kind, q.currency, q.amt, q.refkey
                             order by (((m.m->>'date') between ${from} and ${to})) desc,
                                      (m.m->>'date'), (m.m->>'docId')) as rn_anchor
        from qualified q, jsonb_array_elements(q.members) as m
      )
      select 'group' as src, t.party_id, coalesce(p.display_name, 'Unknown') as party_name,
        t.kind, t.currency, t.amt::text as amt, t.refkey, t.cnt, t.first_date::text as first_date,
        t.last_date::text as last_date, t.span_days, t.members,
        null::text as func_ccy, null::text as ddate, null::text as func_amt, null::text as doc_id,
        null::bigint as group_count
      from top t
      left join parties p on p.id = t.party_id and p.org_id = ${orgId}
      union all
      select 'agg', null::uuid, null::text, null::text, null::text, null::text, null::text,
        null::int, null::text, null::text, null::int, null::jsonb,
        null::text, null::text, null::text, null::text, count(*)
      from qualified
      union all
      select 'buckets', null::uuid, null::text, null::text, null::text, null::text, null::text,
        null::int, null::text, null::text, null::int, null::jsonb,
        func_ccy, ddate::text, sum(func_amt)::text, null::text, null::bigint
      from (select (m->>'funcCcy') as func_ccy, (m->>'date')::text as ddate, (m->>'funcAmount')::numeric as func_amt
            from ranked_members where rn_amt > 1) excess
      group by func_ccy, ddate
      union all
      select 'anchors', null::uuid, null::text, null::text, null::text, null::text, null::text,
        null::int, null::text, null::text, null::int, null::jsonb,
        func_ccy, ddate, func_amt, doc_id, null::bigint
      from ranked_members where rn_anchor = 1
    `)),

    // Weekend-dated documents: top rows for display plus the slim full id
    // set for the flagged union. The detector itself is the accounting
    // document date — no business calendar exists yet, so weekend stays
    // Saturday/Sunday by design (see the module note).
    (db.execute(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
        abs(d.total)::text as amount, d.currency as currency,
        round(abs(d.total) * d.fx_rate, 4)::text as func_amount,
        coalesce(s.base_currency, ${presentationCcy}) as func,
        d.party_id, coalesce(p.display_name, '') as party_name,
        extract(dow from coalesce(d.document_date, d.posting_date))::int as dow,
        'detail' as src
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
      left join currencies cu on cu.code = d.currency
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        -- Same minor-unit dust gate as the shared filter above.
        and abs(coalesce(d.total, 0)) * power(10, coalesce(cu.minor_units, 2)) >= 100
        and extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
      order by abs(d.total) desc
      limit 200
    `)),
    (db.execute(sql`
      select d.id as doc_id,
        round(abs(d.total) * d.fx_rate, 4)::text as func_amount,
        coalesce(s.base_currency, ${presentationCcy}) as func,
        coalesce(d.document_date, d.posting_date)::text as date
      from documents d
      left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
      left join currencies cu on cu.code = d.currency
      where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
        and coalesce(d.document_date, d.posting_date) >= ${from}
        and coalesce(d.document_date, d.posting_date) <= ${to}
        -- Same minor-unit dust gate as the shared filter above.
        and abs(coalesce(d.total, 0)) * power(10, coalesce(cu.minor_units, 2)) >= 100
        and extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
    `)),

    // RSF and z-score share ONE per-(vendor, currency) baseline over the
    // configured window. A single window pass — ordered by amount for the
    // rank, with an explicit full frame so the aggregates still see the whole
    // partition — yields the 2nd-largest, the count, the mean and σ together;
    // the period documents then materialize once and each detector filters
    // them. Partitioning by currency keeps a foreign-currency bill out of the
    // baseline: it can neither false-flag against another currency's history
    // nor inflate σ and mask a genuine same-currency outlier. Detail rows
    // (capped for display) union with the result's full count and the slim
    // full id set, so the counts always cover everything.
    (db.execute(sql`
      -- Rank, mean and σ stay in the document's own currency: rate drift
      -- inside one document currency must never move a ratio or a deviation.
      -- Each baseline row still carries its presentation-money companion
      -- (pres_amt at the row's own document-date spot) for the gates ONLY:
      -- the RSF floor reads the translated 2nd-largest and the z-score floor
      -- the translated deviation. Partitions stay per (vendor, document
      -- currency) — no currency ever blends into another's baseline.
      with baseline as materialized (
        select d.party_id, d.currency, abs(d.total) as amount,
          round(abs(d.total) * d.fx_rate * pres_rate, 4) as pres_amt,
          row_number() over w as rn,
          count(*) over w as cnt,
          avg(abs(d.total)) over w as avg_amount,
          stddev_samp(abs(d.total)) over w as std_amount
        from documents d
        left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id,
        lateral (select case when coalesce(s.base_currency, ${presentationCcy}) = ${presentationCcy} then 1
                             else ${spotRateSql(sql`coalesce(s.base_currency, ${presentationCcy})`, sql`coalesce(d.document_date, d.posting_date)`, presentationCcy, orgId)} end as pres_rate) fxr
        where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
          and d.party_id is not null and abs(coalesce(d.total, 0)) > 0
          and coalesce(d.document_date, d.posting_date) >= ${baselineFrom}
          and coalesce(d.document_date, d.posting_date) <= ${to}
        window w as (partition by d.party_id, d.currency order by abs(d.total) desc
                     rows between unbounded preceding and unbounded following)
      ), stats as (
        select party_id, currency,
          max(amount) filter (where rn = 2) as second_amount,
          max(pres_amt) filter (where rn = 2) as second_pres_amount,
          max(cnt) as cnt, max(avg_amount) as avg_amount, max(std_amount) as std_amount,
          stddev_samp(pres_amt) as std_pres_amount
        from baseline group by party_id, currency
      ), period as materialized (
        select d.id, d.document_number, d.kind,
          coalesce(d.document_date, d.posting_date)::text as date,
          abs(d.total)::text as amount, d.currency as currency,
          round(abs(d.total) * d.fx_rate, 4)::text as func_amount,
          coalesce(s.base_currency, ${presentationCcy}) as func,
          round(abs(d.total) * d.fx_rate * pres_rate, 4) as pres_amt,
          d.party_id, coalesce(p.display_name, 'Unknown') as party_name
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id,
        lateral (select case when coalesce(s.base_currency, ${presentationCcy}) = ${presentationCcy} then 1
                             else ${spotRateSql(sql`coalesce(s.base_currency, ${presentationCcy})`, sql`coalesce(d.document_date, d.posting_date)`, presentationCcy, orgId)} end as pres_rate) fxr
        where d.org_id = ${orgId} and d.voided_at is null and d.kind in (${kindsIn})
          and d.party_id is not null
          and coalesce(d.document_date, d.posting_date) >= ${from}
          and coalesce(d.document_date, d.posting_date) <= ${to}
      ), rsf as (
        -- The multiple compares document-currency amounts; only the noise
        -- gate reads presentation money (the translated 2nd-largest), so a
        -- currency's own history decides the multiple while the configured
        -- floor keeps its meaning in every currency. A missing or zero
        -- 2nd-largest admits nothing — division needs a positive denominator.
        -- An unset floor refuses the detector: the bound NULL makes every
        -- comparison unknown, the join admits no rows, and rsfUnavailable
        -- names the exclusion in the score and sections.
        -- No LIMIT: outlier sets are inherently small, and the flagged union
        -- below needs every flagged id — display slices cap client-side.
        select pd.*, s.second_amount::text as second_amount, s.cnt as baseline_count,
          null::text as avg_amount, null::text as std_amount,
          pd.amount::numeric / s.second_amount as metric
        from period pd
        join stats s on s.party_id = pd.party_id and s.currency = pd.currency
          and s.second_amount > 0
          and s.second_pres_amount >= ${rsfFloor}::numeric
        where pd.amount::numeric / s.second_amount >= ${cfg.rsfThreshold}
        order by metric desc
      ), zs as (
        -- Deviations compare document-currency amounts against the
        -- document-currency mean and σ; only the σ gate reads presentation
        -- money (the translated deviation). An unset floor refuses the
        -- detector the same way: NULL comparisons match nothing and
        -- zscoreUnavailable names the exclusion.
        select pd.*, null::text as second_amount, s.cnt as baseline_count,
          s.avg_amount::text as avg_amount, s.std_amount::text as std_amount,
          (pd.amount::numeric - s.avg_amount) / s.std_amount as metric
        from period pd
        join stats s on s.party_id = pd.party_id and s.currency = pd.currency
          and s.cnt >= ${cfg.zscoreMinBaseline} and s.std_pres_amount > ${zscoreFloor}::numeric
        where abs((pd.amount::numeric - s.avg_amount) / s.std_amount) >= ${cfg.zscoreThreshold}
        order by abs((pd.amount::numeric - s.avg_amount) / s.std_amount) desc
      )
      select 'rsf' as src, * from rsf
      union all
      select 'z' as src, * from zs
    `)),

    // Sequential invoice runs — gaps-and-islands over vendor reference numbers,
    // one island space per (vendor, document currency): a run is only a run
    // in a single currency. Detail rows (top 50 by span, then run length —
    // exact and currency-blind) carry the full island count, and a second leg
    // unnests every island's invoices slim for the flagged union, so runs
    // past the display cut still count.
    (db.execute(sql`
      with refs as (
        select d.id, d.document_number, d.reference_number, d.party_id, d.currency,
          coalesce(d.document_date, d.posting_date) as doc_date, abs(d.total)::text as amount,
          round(abs(d.total) * d.fx_rate, 4)::text as func_amount,
          coalesce(s.base_currency, ${presentationCcy}) as func_ccy,
          (regexp_match(d.reference_number, '([0-9]+)[^0-9]*$'))[1]::numeric as ref_num
        from documents d
        left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
        where d.org_id = ${orgId} and d.voided_at is null and d.kind = 'vendor_bill'
          and d.party_id is not null and d.reference_number ~ '[0-9]'
          and coalesce(d.document_date, d.posting_date) >= ${from}
          and coalesce(d.document_date, d.posting_date) <= ${to}
      ), numbered as (
        select *, ref_num - row_number() over (partition by party_id, currency order by ref_num) as island
        from refs
        -- The 9,999,999 ceiling is a cast guard for the numeric island
        -- arithmetic, not a business threshold.
        where ref_num is not null and ref_num <= 9999999
      ), islands as materialized (
        select party_id, currency, island, count(*) as cnt,
          min(ref_num) as start_ref, max(ref_num) as end_ref,
          min(doc_date) as first_date, max(doc_date) as last_date,
          (max(doc_date) - min(doc_date)) as span_days,
          jsonb_agg(jsonb_build_object('docId', id, 'docNumber', document_number, 'reference', reference_number,
            'date', doc_date::text, 'amount', amount, 'currency', currency,
            'funcAmount', func_amount, 'funcCcy', func_ccy) order by ref_num) as invoices
        from numbered
        group by party_id, currency, island
        having count(*) >= ${SEQUENTIAL_MIN} and count(*) = count(distinct ref_num)
      )
      select 'detail' as src, i.*, coalesce(p.display_name, 'Unknown') as party_name,
        -- The group count applies the same span gate as the display leg:
        -- islands below the minimum span are not sequential runs.
        (select count(*) from islands where span_days >= ${SEQUENTIAL_MIN_DAYS_FOR_FLAG}) as full_count
      from islands i
      left join parties p on p.id = i.party_id and p.org_id = ${orgId}
      where i.span_days >= ${SEQUENTIAL_MIN_DAYS_FOR_FLAG}
      order by i.span_days desc, i.cnt desc, i.party_id, i.currency
      limit 50
    `)),
    (db.execute(sql`
      with refs as (
        select d.id, d.party_id, d.currency,
          abs(d.total)::text as amount,
          round(abs(d.total) * d.fx_rate, 4)::text as func_amount,
          coalesce(s.base_currency, ${presentationCcy}) as func_ccy,
          coalesce(d.document_date, d.posting_date)::text as ddate,
          (regexp_match(d.reference_number, '([0-9]+)[^0-9]*$'))[1]::numeric as ref_num
        from documents d
        left join subsidiaries s on s.id = d.subsidiary_id and s.org_id = d.org_id
        where d.org_id = ${orgId} and d.voided_at is null and d.kind = 'vendor_bill'
          and d.party_id is not null and d.reference_number ~ '[0-9]'
          and coalesce(d.document_date, d.posting_date) >= ${from}
          and coalesce(d.document_date, d.posting_date) <= ${to}
      ), numbered as (
        select *, ref_num - row_number() over (partition by party_id, currency order by ref_num) as island
        from refs
        where ref_num is not null and ref_num <= 9999999
      ), islands as materialized (
        select party_id, currency, island, count(*) as cnt,
          min(doc_date_val) as first_date, max(doc_date_val) as last_date,
          (max(doc_date_val) - min(doc_date_val)) as span_days
        from (select *, ddate::date as doc_date_val from numbered) n
        group by party_id, currency, island
        having count(*) >= ${SEQUENTIAL_MIN} and count(*) = count(distinct ref_num)
      )
      select n.id as doc_id, n.func_amount as func_amount, n.func_ccy as func, n.ddate as date
      from numbered n
      join islands i using (party_id, currency, island)
      where i.span_days >= ${SEQUENTIAL_MIN_DAYS_FOR_FLAG}
    `)),

    // Ghost vendors — the full two-phase detector, both phases in SQL.
    // Phase 1: company-vendor names vs employee names, where "employee" means
    // a row in employee_roles (the role view — never the party kind, which
    // misses kind='employee' parties and sweeps in every person). Name
    // containment uses strpos, so a vendor name holding LIKE wildcards
    // cannot escape into a pattern. Phase 2: shared street address — line1
    // normalized (English street-type abbreviations, then punctuation and
    // whitespace stripped while KEEPING every script's letters and digits, so
    // accented and non-Latin addresses never collapse into each other) plus
    // postal code plus country. Detail rows carry the full match count.
    (db.execute(sql`
      with norm_addr as (
        select a.party_id,
          regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
            regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
              regexp_replace(lower(trim(a.line1)), '\mstreet\M', 'st'), '\mroad\M', 'rd'),
              '\mavenue\M', 'ave'), '\mdrive\M', 'dr'),
            '\mcourt\M', 'ct'), '\mboulevard\M', 'blvd'), '\mlane\M', 'ln'), '\mplace\M', 'pl'),
            '\mnorth\M', 'n'), '\msouth\M', 's'), '\meast\M', 'e'), '\mwest\M', 'w'),
            '[[:space:][:punct:]]', '', 'g')
            || '|' || coalesce(regexp_replace(upper(a.postal_code), '\s', '', 'g'), '')
            || '|' || coalesce(upper(a.country), '') as addr_key
        from addresses a
        where a.org_id = ${orgId} and a.line1 is not null and length(trim(a.line1)) >= 5
      ), matches as (
        select v.id as vendor_id, v.display_name as vendor_name,
          e.id as employee_id, e.display_name as employee_name,
          bool_or(
            length(trim(e.display_name)) >= ${cfg.ghostNameMinLength} and (
              upper(trim(v.display_name)) = upper(trim(e.display_name))
              or strpos(upper(v.display_name), upper(trim(e.display_name))) > 0
            )
          ) as name_match,
          bool_or(va.addr_key is not null and va.addr_key = ea.addr_key) as address_match
        from parties v
        join parties e on e.org_id = v.org_id and e.id != v.id and e.is_active
        join employee_roles er on er.org_id = e.org_id and er.party_id = e.id
        left join norm_addr va on va.party_id = v.id
        left join norm_addr ea on ea.party_id = e.id
        where v.org_id = ${orgId} and v.kind = 'company' and v.is_active
          and exists (
            select 1 from documents dv
            where dv.org_id = v.org_id and dv.party_id = v.id
              and dv.kind in ('vendor_bill', 'check', 'vendor_payment')
          )
        group by v.id, v.display_name, e.id, e.display_name
        having bool_or(
            length(trim(e.display_name)) >= ${cfg.ghostNameMinLength} and (
              upper(trim(v.display_name)) = upper(trim(e.display_name))
              or strpos(upper(v.display_name), upper(trim(e.display_name))) > 0
            )
          )
          or bool_or(va.addr_key is not null and va.addr_key = ea.addr_key)
      )
      select *, (select count(*) from matches) as full_count from matches limit 50
    `)),

    // Native audit trail in the org's time zone: the window compares day
    // bounds as wall midnight in the org zone, and each event carries its
    // zone-rendered wall time for display alongside the raw instant.
    (db.execute(sql`
      select a.id, a.table_name, a.row_id::text as row_id, a.action, a.actor_id::text as actor_id,
        a.at::text as at,
        to_char(a.at at time zone ${auditZone}, 'YYYY-MM-DD HH24:MI') as display_at,
        left(coalesce(a.changes::text, ''), 200) as changes
      from audit_log a
      where a.org_id = ${orgId}
        and a.at >= ((${from}::timestamp) at time zone ${auditZone})
        and a.at < (((${to}::date + 1)::timestamp) at time zone ${auditZone})
        and (
          a.action in ('delete', 'DELETE')
          or a.table_name in ('parties', 'bank_accounts')
          or a.changes::text ~* 'bank|routing|iban|account_number|email|address'
        )
      order by a.at desc
      limit 100
    `)),
    (db.execute(sql`
      select count(*) as total,
        count(*) filter (where action in ('delete', 'DELETE')) as deletes,
        count(*) filter (where changes::text ~* 'bank|routing|iban|account_number|email|address') as sensitive
      from audit_log
      where org_id = ${orgId}
        and at >= ((${from}::timestamp) at time zone ${auditZone})
        and at < (((${to}::date + 1)::timestamp) at time zone ${auditZone})
    `)),

  ]);

  // Split the one grouping-sets result back into its shapes. grouping(col)
  // is 0 exactly when that column is a real key for the row. Benford sets are
  // keyed (currency, digit): one distribution per document currency.
  const dupAllRows = (dupAll.rows);
  const dupGroupRows = { rows: dupAllRows.filter((r) => (r as { src: string }).src === "group") };
  const dupAggRow = dupAllRows.find((r) => (r as { src: string }).src === "agg");
  const dupBucketRows = dupAllRows.filter((r) => (r as { src: string }).src === "buckets");
  const dupAnchorRows = dupAllRows.filter((r) => (r as { src: string }).src === "anchors");

  const vendorStats = (vendorStatRows.rows);
  const rsfRows = { rows: vendorStats.filter((r) => (r as { src: string }).src === "rsf").map((r) => ({ ...r, rsf: (r as { metric: string | number }).metric })) };
  const zRows = { rows: vendorStats.filter((r) => (r as { src: string }).src === "z").map((r) => ({ ...r, z: (r as { metric: string | number }).metric })) };

  const aggAll = aggRows.rows as AggregateRow[];
  const metaRow = aggAll.find((r) =>
    ["g_func", "g_cur", "g_digit1", "g_digit2", "g_trap", "g_dow", "g_date"].every((f) => Number(r[f]) === 1));
  // Benford's law is defined on leading digits 1-9 (first digit) and 10-99
  // (first two): a '0' leading digit or a short second digit from a sub-unit
  // amount is not a Benford observation, so those rows never enter a slice.
  const b1Rows = {
    rows: aggAll
      .filter((r) => Number(r.g_digit1) === 0 && Number(r.g_cur) === 0 && r.digit1 !== null && String(r.digit1) !== "0")
      .map((r) => ({ currency: String(r.cur), digit: r.digit1, count: r.count, amount: r.txn_amount })),
  };
  const b2Rows = {
    rows: aggAll
      .filter((r) => Number(r.g_digit2) === 0 && Number(r.g_cur) === 0 && r.digit2 !== null && String(r.digit2).length === 2)
      .map((r) => ({ currency: String(r.cur), digits: r.digit2, count: r.count, amount: r.txn_amount })),
  };
  const trapAgg = {
    rows: aggAll
      .filter((r) => Number(r.g_trap) === 0 && Number(r.g_func) === 1 && Number(r.g_date) === 1 && r.trap !== null),
  };
  const weekendAgg = {
    rows: aggAll
      .filter((r) => Number(r.g_dow) === 0 && Number(r.g_func) === 1 && Number(r.g_date) === 1 && r.dow !== null),
  };
  // Translation buckets: every consolidated total below is translated from
  // these per-(functional currency, date) first-leg sums — never by adding
  // mixed currencies raw.
  interface Bucket { func: string; date: string; amount: string }
  const buckets: Bucket[] = aggAll
    .filter((r) => Number(r.g_func) === 0 && Number(r.g_date) === 0
      && Number(r.g_trap) === 1 && Number(r.g_dow) === 1 && r.func !== null)
    .map((r) => ({ func: String(r.func), date: String(r.date), amount: String(r.amount) }));
  const trapBuckets: (Bucket & { trap: string })[] = aggAll
    .filter((r) => Number(r.g_trap) === 0 && Number(r.g_func) === 0 && Number(r.g_date) === 0 && r.trap !== null)
    .map((r) => ({ func: String(r.func), date: String(r.date), amount: String(r.amount), trap: String(r.trap) }));
  const weekendBuckets: Bucket[] = aggAll
    .filter((r) => Number(r.g_dow) === 0 && Number(r.g_func) === 0 && Number(r.g_date) === 0 && r.dow !== null)
    .map((r) => ({ func: String(r.func), date: String(r.date), amount: String(r.amount) }));

  // One rate context for every translation on this page: buckets, duplicate
  // members and anchors, every detail row. A functional/date pair with no
  // spot coverage throws by name instead of silently mistranslating.
  const ratePairs: { func: string | null; date: string }[] = [
    ...buckets.map((b) => ({ func: b.func, date: b.date })),
    ...trapBuckets.map((b) => ({ func: b.func, date: b.date })),
    ...weekendBuckets.map((b) => ({ func: b.func, date: b.date })),
    ...(trapRows.rows as FlaggedDocumentRow[]).map((r) => ({ func: r.func, date: r.date })),
    ...dupBucketRows.map((r) => ({ func: (r as { func_ccy: string }).func_ccy, date: String((r as { ddate: string }).ddate) })),
    ...dupAnchorRows.map((r) => ({ func: (r as { func_ccy: string }).func_ccy, date: String((r as { ddate: string }).ddate) })),
    ...((dupGroupRows.rows as DuplicateGroupRow[]).flatMap((g) => (g.members ?? []).map((m) => ({ func: m.funcCcy, date: m.date })))),
    ...((weekendDetail.rows as FlaggedDocumentRow[]).map((r) => ({ func: r.func, date: r.date }))),
    ...((weekendIds.rows as FlaggedIdRow[]).map((r) => ({ func: r.func, date: r.date }))),
    ...((rsfRows.rows as VendorStatisticRow[]).map((r) => ({ func: r.func, date: r.date }))),
    ...((zRows.rows as VendorStatisticRow[]).map((r) => ({ func: r.func, date: r.date }))),
    ...((seqDetail.rows as SequentialRow[]).flatMap((g) => ((g.invoices as SequentialRow["invoices"]) ?? []).map((inv) => ({ func: inv.funcCcy, date: inv.date })))),
    ...((seqIds.rows as FlaggedIdRow[]).map((r) => ({ func: r.func, date: r.date }))),
  ];
  const rates: FlowRates = await flowRates(orgId, ratePairs);
  const present = (funcAmt: string, func: string, date: string): string =>
    mulDecimal(funcAmt, rates.rateAt(func, date));

  // Consolidated totals, each translated bucket by bucket and summed exact.
  const translateBuckets = (rows: Bucket[]): string => {
    let total = "0.0000";
    for (const b of rows) total = add(total, present(b.amount, b.func, b.date));
    return total;
  };
  const metaTotal = translateBuckets(buckets);
  const trapTotalAmount = translateBuckets(trapBuckets);
  const weekendTotalAmount = translateBuckets(weekendBuckets);
  const calendarByDate = new Map<string, Bucket[]>();
  for (const b of buckets) {
    const list = calendarByDate.get(b.date);
    if (list) list.push(b);
    else calendarByDate.set(b.date, [b]);
  }
  const calendar = [...calendarByDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, rows]) => ({ date, count: 0, amount: translateBuckets(rows) }));
  const metaCount = Number(metaRow?.count ?? 0);
  // Per-date counts ride the calendar from the buckets' row counts — the
  // bucket rows each carry their set count.
  const calendarCounts = new Map<string, number>();
  for (const r of aggAll.filter((x) => Number(x.g_func) === 0 && Number(x.g_date) === 0
    && Number(x.g_trap) === 1 && Number(x.g_dow) === 1)) {
    calendarCounts.set(String(r.date), (calendarCounts.get(String(r.date)) ?? 0) + Number(r.count));
  }
  for (const day of calendar) day.count = calendarCounts.get(day.date) ?? 0;

  // ---- Benford 1D + 2D, one distribution per document currency --------------
  // Digit rows arrive keyed (currency, digit) with exact transaction sums.
  // Below the configured minimum sample a slice reports `insufficient` and
  // never scores — an empty period is insufficient, never nonconforming.
  // Per-digit anomalies use the Z-statistic from Benford's Law
  // (Mark Nigrini, 2012), not a fixed deviation band.
  const minSample = cfg.benfordMinSample;
  const slice1D = (currency: string, rows: { digit: unknown; count: unknown; amount: unknown }[]): BenfordCurrencySlice => {
    const map = new Map<string, { count: number; amount: string }>(
      rows.map((r) => [String(r.digit), { count: Number(r.count), amount: String(r.amount ?? "0") }]),
    );
    const total = [...map.values()].reduce((s, v) => s + v.count, 0);
    let sumAbsDev = 0;
    const digits: BenfordDigit[] = [];
    for (let d = 1; d <= 9; d++) {
      const row = map.get(String(d));
      const observed = row && total > 0 ? row.count / total : 0;
      const expected = BENFORD_1D[d]!;
      const deviation = observed - expected;
      sumAbsDev += Math.abs(deviation);
      const deviationPct = expected > 0 ? (deviation / expected) * 100 : 0;
      digits.push({
        digit: d, count: row?.count ?? 0, amount: row?.amount ?? "0.0000",
        observed, expected, deviationPct,
        isAnomaly: total >= minSample && benfordDigitZ(observed, expected, total) > 1.96,
      });
    }
    const mad = sumAbsDev / 9;
    if (total < minSample) {
      return {
        currency, totalTransactions: total, digits, mad,
        conformity: "insufficient",
        message: strings.benfordInsufficient(total, minSample),
        anomalies: [],
      };
    }
    // The message follows the conformity code, never a restated copy of
    // the bands: benfordConformity1D owns the cut-offs.
    const conformity = benfordConformity1D(mad);
    return {
      currency, totalTransactions: total, digits, mad,
      conformity,
      message:
        conformity === "excellent"
          ? strings.benfordClose
          : conformity === "acceptable"
            ? strings.benfordReasonable
            : conformity === "marginal"
              ? strings.benfordSomeDeviation
              : strings.benfordSignificant,
      anomalies: digits.filter((x) => x.isAnomaly),
    };
  };
  const slice2D = (currency: string, rows: { digits: unknown; count: unknown; amount: unknown }[]): BenfordCurrencySlice => {
    const map = new Map<string, { count: number; amount: string }>(
      rows.map((r) => [String(r.digits), { count: Number(r.count), amount: String(r.amount ?? "0") }]),
    );
    const total = [...map.values()].reduce((s, v) => s + v.count, 0);
    let sumAbsDev = 0;
    const digits: BenfordDigit[] = [];
    for (let d = 10; d <= 99; d++) {
      const row = map.get(String(d));
      const observed = row && total > 0 ? row.count / total : 0;
      const expected = Math.log10(1 + 1 / d);
      const deviation = observed - expected;
      sumAbsDev += Math.abs(deviation);
      const deviationPct = expected > 0 ? (deviation / expected) * 100 : 0;
      digits.push({
        digit: d, count: row?.count ?? 0, amount: row?.amount ?? "0.0000",
        observed, expected, deviationPct,
        isAnomaly: total >= minSample && benfordDigitZ(observed, expected, total) > 1.96,
      });
    }
    const mad = sumAbsDev / 90;
    if (total < minSample) {
      return {
        currency, totalTransactions: total, digits, mad,
        conformity: "insufficient", message: strings.benfordInsufficient(total, minSample),
        anomalies: [],
      };
    }
    return {
      currency, totalTransactions: total, digits, mad,
      conformity: benfordConformity2D(mad), message: "",
      anomalies: digits.filter((x) => x.isAnomaly && x.count >= 5).sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct)),
    };
  };
  const byCurrency = <T extends { currency: string }>(rows: T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      const list = out.get(r.currency);
      if (list) list.push(r);
      else out.set(r.currency, [r]);
    }
    return out;
  };
  const b1Slices = [...byCurrency(b1Rows.rows).entries()]
    .map(([currency, rows]) => slice1D(currency, rows))
    .sort((a, b) => b.totalTransactions - a.totalTransactions || (a.currency < b.currency ? -1 : 1));
  const b2Slices = [...byCurrency(b2Rows.rows).entries()]
    .map(([currency, rows]) => slice2D(currency, rows))
    .sort((a, b) => b.totalTransactions - a.totalTransactions || (a.currency < b.currency ? -1 : 1));
  // The legacy top-level shape carries the largest slice so single-currency
  // datasets (and existing consumers) read identical figures. SCORING reads
  // every sufficient slice below — one currency's nonconformity never hides
  // behind another's volume.
  const b1Top = b1Slices[0] ?? slice1D("", []);
  const b2Top = b2Slices[0] ?? slice2D("", []);
  const sufficient1D = b1Slices.filter((s) => s.totalTransactions >= minSample);
  const deviating1D = sufficient1D.filter((s) => s.conformity === "nonConforming");
  const digits1D = b1Top.digits;
  const total1D = b1Top.totalTransactions;
  const mad1D = b1Top.mad;
  const benfordMessage = b1Top.message;
  const digits2D = b2Top.digits;
  const total2D = b2Top.totalTransactions;
  const mad2D = b2Top.mad;
  const anomalies2D = b2Top.anomalies;

  // Per-document translated amount for tier comparisons: the document's own
  // first-leg figure completed into presentation at its date spot.
  const translatedOf = (row: { func_amount: string; func: string; date: string }): string =>
    present(row.func_amount, row.func, row.date);

  // ---- Threshold trap ------------------------------------------------------------
  const trapRules = RISK_SCORING.trap.rules;
  const trapItems: FlaggedDoc[] = (trapRows.rows as FlaggedDocumentRow[]).map((r) => ({
    docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
    amount: r.amount, currency: r.currency, funcAmount: translatedOf(r),
    partyId: r.party_id, partyName: strings.displayPartyName(r.party_name),
    flagType: "trap" as const,
    reason: strings.trapReason(r.trap as string),
    riskScore: r.trap === "9999" ? trapRules.ends9999.points : r.trap === "999" ? trapRules.ends999.points : trapRules.ends99.points,
  }));
  const trapByTrap = (trapAgg.rows as AggregateRow[]).map((r) => ({ trap: String(r.trap), count: Number(r.count), amount: "0.0000" }));
  for (const t of trapByTrap) {
    t.amount = translateBuckets(trapBuckets.filter((b) => b.trap === t.trap));
  }
  const trapTotal = trapByTrap.reduce((s, t) => s + t.count, 0);
  const trapUnavailable = flowLimits.length === 0 ? strings.trapUnavailable : null;
  const rsfUnavailable = rsfFloor === null ? strings.rsfFloorUnset : statsSpotRefusal;
  const zscoreUnavailable = zscoreFloor === null ? strings.zscoreFloorUnset : statsSpotRefusal;
  const amountTierUnset =
    cfg.moderateRiskAmount === "" || cfg.highRiskAmount === "" || cfg.criticalRiskAmount === "" ||
    cfg.aggregateHighAmount === "" || cfg.aggregateCriticalAmount === "";

  // ---- Duplicates: one finding per natural-key group ---------------------------------
  const dupRules = RISK_SCORING.duplicate.rules;
  const dupTierBump = (translated: string): number =>
    ladderBump(translated, [
      { rule: dupRules.tierCritical, threshold: cfg.criticalRiskAmount },
      { rule: dupRules.tierHigh, threshold: cfg.highRiskAmount },
      { rule: dupRules.tierModerate, threshold: cfg.moderateRiskAmount },
    ]);
  const dupSpanBump = (spanDays: number): number => {
    if (spanDays <= dupRules.span1Day.days) return dupRules.span1Day.points;
    if (spanDays <= dupRules.span3Days.days) return dupRules.span3Days.points;
    if (spanDays <= dupRules.span7Days.days) return dupRules.span7Days.points;
    return 0;
  };
  const dupConfidence = (sameReference: boolean, spanDays: number): number => {
    if (sameReference) return dupRules.confSharedReference.confidence;
    if (spanDays <= dupRules.confSpan3Days.days) return dupRules.confSpan3Days.confidence;
    if (spanDays <= dupRules.confSpan7Days.days) return dupRules.confSpan7Days.confidence;
    return dupRules.confOtherwise.confidence;
  };
  const dupGroups: DuplicateGroup[] = (dupGroupRows.rows as DuplicateGroupRow[]).map((r) => {
    const amount = r.amt;
    const count = Number(r.cnt);
    const spanDays = Number(r.span_days);
    const sameReference = r.refkey !== "";
    const members: DuplicateMember[] = (r.members ?? []).map((m) => ({
      docId: m.docId, docNumber: m.docNumber ?? "", reference: m.reference ?? "",
      date: m.date, amount: m.amount, currency: m.currency,
      funcAmount: present(m.funcAmount, m.funcCcy, m.date), memo: m.memo,
    }));
    const presented = members.map((m) => m.funcAmount);
    const funcTotal = sum(presented.length > 0 ? presented : ["0.0000"]);
    let score = dupRules.base.points + dupTierBump(funcTotal) + dupSpanBump(spanDays);
    if (sameReference) score += dupRules.sharedReference.points;
    return {
      groupId: [r.party_id ?? "", r.kind, r.currency, amount, r.refkey].join("|"),
      partyId: r.party_id, partyName: strings.displayPartyName(r.party_name),
      kind: r.kind, currency: r.currency, amount, funcTotal,
      count, dateSpanDays: spanDays, firstDate: r.first_date, lastDate: r.last_date,
      sameReference,
      confidence: dupConfidence(sameReference, spanDays),
      riskScore: Math.min(100, score),
      members,
    };
  });
  // Display order follows translated value at risk, so the largest excess
  // leads whatever the cut order fetched.
  dupGroups.sort((a, b) => cmp(b.funcTotal, a.funcTotal));
  const dupTotal = Number((dupAggRow as { group_count: string | number } | undefined)?.group_count ?? 0);
  const dupValueBuckets: Bucket[] = dupBucketRows.map((r) => ({
    func: String((r as { func_ccy: string }).func_ccy),
    date: String((r as { ddate: string }).ddate),
    amount: String((r as { func_amt: string }).func_amt),
  }));
  const dupAmount = translateBuckets(dupValueBuckets);
  const duplicateUnavailable = duplicateFloor === null ? strings.duplicateFloorUnset : null;

  // Compatibility projection for pair-shaped readers of the finding: every
  // within-group ordered pair, so existing consumers keep working.
  // Same-currency and same-reference by construction — the cross-currency
  // false positive cannot appear here either.
  const dupPairs: DuplicatePair[] = [];
  for (const g of dupGroups) {
    const ms = g.members;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i]!, b = ms[j]!;
        const days = Math.abs(calendarDaysBetween(a.date, b.date));
        const sameMemo = a.memo !== null && a.memo === b.memo;
        let score = dupRules.base.points + dupTierBump(g.funcTotal) + dupSpanBump(days);
        if (sameMemo || g.sameReference) score += dupRules.sharedReference.points;
        dupPairs.push({
          docId1: a.docId, docId2: b.docId, docNumber1: a.docNumber, docNumber2: b.docNumber,
          kind: g.kind, date1: a.date, date2: b.date, daysBetween: days, amount: g.amount,
          currency: g.currency, partyId: g.partyId, partyName: g.partyName,
          sameMemo,
          confidence: sameMemo || g.sameReference
            ? dupRules.confSharedReference.confidence
            : dupConfidence(false, days),
          riskScore: Math.min(100, score),
        });
      }
    }
  }
  dupPairs.sort((x, y) => cmp(y.amount, x.amount) || x.daysBetween - y.daysBetween
    || (x.docId1 < y.docId1 ? -1 : 1) || (x.docId2 < y.docId2 ? -1 : 1));
  const dupPairsCapped = dupPairs.slice(0, 200);

  // ---- Weekend ------------------------------------------------------------------------
  const weekendRules = RISK_SCORING.weekend.rules;
  const weekendItems: FlaggedDoc[] = (weekendDetail.rows as FlaggedDocumentRow[]).map((r) => {
    const translated = translatedOf(r);
    const isSunday = Number(r.dow) === 0;
    let score = weekendRules.base.points;
    score += ladderBump(translated, [
      { rule: weekendRules.tierCritical, threshold: cfg.criticalRiskAmount },
      { rule: weekendRules.tierHigh, threshold: cfg.highRiskAmount },
    ]);
    if (isSunday) score += weekendRules.sunday.points;
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount: r.amount, currency: r.currency, funcAmount: translated,
      partyId: r.party_id, partyName: strings.displayPartyName(r.party_name),
      flagType: "weekend" as const,
      reason: strings.weekendReason(isSunday),
      riskScore: Math.min(100, score),
    };
  });
  let satCount = 0, sunCount = 0;
  for (const r of (weekendAgg.rows as AggregateRow[])) {
    if (Number(r.dow) === 0) sunCount = Number(r.count);
    else satCount = Number(r.count);
  }
  const weekendTotal = satCount + sunCount;

  // ---- RSF ------------------------------------------------------------------------------
  const rsfRules = RISK_SCORING.rsf.rules;
  // Without spot coverage the gates cannot be verified, so a refused probe
  // darkens both detectors instead of emitting findings from a partial
  // baseline. The unavailable flags above name the missing coverage.
  const rsfFull = statsSpotRefusal !== null ? [] : (rsfRows.rows as VendorStatisticRow[]);
  const rsfItems = rsfFull.map((r) => {
    const rsf = Number(r.rsf);
    const translated = translatedOf(r);
    let score = rsfRules.base.points;
    if (rsf >= rsfRules.ratio50.ratio) score += rsfRules.ratio50.points;
    else if (rsf >= rsfRules.ratio20.ratio) score += rsfRules.ratio20.points;
    else if (rsf >= rsfRules.ratio15.ratio) score += rsfRules.ratio15.points;
    else score += rsfRules.ratioBase.points;
    score += ladderBump(translated, [
      { rule: rsfRules.tierCritical, threshold: cfg.criticalRiskAmount },
      { rule: rsfRules.tierHigh, threshold: cfg.highRiskAmount },
    ]);
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount: r.amount, currency: r.currency, funcAmount: translated,
      partyId: r.party_id, partyName: strings.displayPartyName(r.party_name),
      flagType: "rsf" as const,
      reason: strings.rsfReason(rsf, strings.displayPartyName(r.party_name), String(r.currency)),
      riskScore: Math.min(100, score),
      rsf, secondLargest: r.second_amount, baselineCount: Number(r.baseline_count),
    };
  });

  // ---- Z-score ------------------------------------------------------------------------------
  // No upper |z| bound: the most extreme outliers are the finding, and the
  // ordering already surfaces them first. Display rounds; it never filters.
  const zRules = RISK_SCORING.zscore.rules;
  const zFull = statsSpotRefusal !== null ? [] : (zRows.rows as VendorStatisticRow[]);
  const zItems = zFull.map((r) => {
    const z = Number(r.z);
    const translated = translatedOf(r);
    let score = zRules.base.points;
    if (Math.abs(z) >= zRules.z5.z) score += zRules.z5.points;
    else if (Math.abs(z) >= zRules.z4.z) score += zRules.z4.points;
    score += ladderBump(translated, [{ rule: zRules.tierCritical, threshold: cfg.criticalRiskAmount }]);
    return {
      docId: r.id, docNumber: r.document_number ?? "", kind: r.kind, date: r.date,
      amount: r.amount, currency: r.currency, funcAmount: translated,
      partyId: r.party_id, partyName: strings.displayPartyName(r.party_name),
      flagType: "zscore" as const,
      reason: strings.zscoreReason(Math.abs(z), strings.displayPartyName(r.party_name), String(r.currency), Number(r.baseline_count)),
      riskScore: Math.min(100, score),
      zScore: z, vendorAvg: r.avg_amount, vendorStdDev: r.std_amount, baselineCount: Number(r.baseline_count),
    };
  });
  const rsfDisplay = rsfItems.slice(0, 100);
  const zDisplay = zItems.slice(0, 200);

  // ---- Sequential runs -----------------------------------------------------------------------
  const seqRules = RISK_SCORING.sequential.rules;
  const seqHighDays = cfg.sequentialHighRiskDays;
  const sequential: SequentialGroup[] = (seqDetail.rows as SequentialRow[]).map((r) => {
    const spanDays = Number(r.span_days);
    const count = Number(r.cnt);
    const invoices = ((r.invoices as SequentialRow["invoices"]) ?? []).map((inv) => ({
      docId: inv.docId, docNumber: inv.docNumber, reference: inv.reference, date: inv.date,
      amount: inv.amount, currency: inv.currency, funcAmount: present(inv.funcAmount, inv.funcCcy, inv.date),
    }));
    const totalAmount = sum(invoices.length > 0 ? invoices.map((inv) => inv.funcAmount) : ["0.0000"]);
    let score = spanDays >= seqHighDays ? seqRules.highSpan.points : seqRules.baseSpan.points;
    score += Math.min(count * seqRules.perInvoice.perUnit, seqRules.perInvoice.cap);
    score += ladderBump(
      totalAmount,
      [
        { rule: seqRules.tierCritical, threshold: cfg.aggregateCriticalAmount },
        { rule: seqRules.tierHigh, threshold: cfg.aggregateHighAmount },
        { rule: seqRules.tierModerate, threshold: cfg.criticalRiskAmount },
      ],
      true,
    );
    const level: "high" | "medium" = spanDays >= seqHighDays ? "high" : "medium";
    return {
      partyId: r.party_id, partyName: strings.displayPartyName(r.party_name), count, totalAmount,
      currency: r.currency,
      startRef: Number(r.start_ref), endRef: Number(r.end_ref), dateSpanDays: spanDays,
      firstDate: String(r.first_date), lastDate: String(r.last_date),
      riskLevel: level, riskScore: Math.min(100, score),
      reason: strings.sequentialReason(count, String(r.start_ref), String(r.end_ref), spanDays, level === "high", String(r.currency)),
      invoices: invoices.slice(0, 12),
    };
  });
  const seqDetailRows = seqDetail.rows as SequentialRow[];
  const sequentialGroups = seqDetailRows.length > 0 ? Number(seqDetailRows[0]!.full_count ?? 0) : 0;

  // ---- Ghost vendors (tiers from the severity model) -----------------------
  const ghostRules = RISK_SCORING.ghost.rules;
  const ghostFull = ghostRows.rows as GhostRow[];
  const ghosts: GhostVendor[] = ghostFull.map((r) => {
    const name = Boolean(r.name_match);
    const addr = Boolean(r.address_match);
    const matchType: GhostVendor["matchType"] = name && addr ? "name+address" : addr ? "address" : "name";
    return {
      vendorId: r.vendor_id, vendorName: r.vendor_name, employeeId: r.employee_id, employeeName: r.employee_name,
      matchType,
      riskScore: name && addr ? ghostRules.nameAndAddress.points : addr ? ghostRules.addressOnly.points : ghostRules.nameOnly.points,
      reason: name && addr
        ? strings.ghostBoth(String(r.vendor_name), String(r.employee_name))
        : addr
          ? strings.ghostAddress(String(r.vendor_name), String(r.employee_name))
          : strings.ghostName(String(r.vendor_name), String(r.employee_name)),
    };
  }).sort((a, b) => b.riskScore - a.riskScore);
  const ghostCount = ghostFull.length > 0 ? Number(ghostFull[0]!.full_count ?? ghostFull.length) : 0;

  // ---- Audit trail ---------------------------------------------------------------------------------
  const auditEvents: AuditEvent[] = ((auditRows.rows as AuditRow[])).map((r) => ({
    id: r.id, tableName: r.table_name, rowId: r.row_id, action: r.action, actorId: r.actor_id, at: r.at,
    displayAt: r.display_at,
    summary: strings.auditEvent(auditEventArgs(r.action, r.actor_id, r.table_name, r.row_id, r.changes)),
  }));
  const auditTotal = Number((auditAgg.rows[0] as { total: string | number } | undefined)?.total ?? 0);
  const auditDeletes = Number((auditAgg.rows[0] as { deletes: string | number } | undefined)?.deletes ?? 0);
  const auditSensitive = Number((auditAgg.rows[0] as { sensitive: string | number } | undefined)?.sensitive ?? 0);

  // ---- Flagged aggregate (dedup by doc, stable order) -----------------------------------------------
  // Display findings (capped per detector) for the tabs…
  const flagged: FlaggedDoc[] = [];
  const seen = new Set<string>();
  const push = (f: FlaggedDoc) => { if (!seen.has(f.docId)) { seen.add(f.docId); flagged.push(f); } };
  for (const g of dupGroups) {
    // The group scan includes the threshold-sized boundary on both sides of
    // the report period. Anchor the single group finding to its earliest
    // in-period member; the reason lists the whole group.
    const inPeriod = g.members.filter((m) => m.date >= from && m.date <= to);
    const anchor = inPeriod[0] ?? g.members[0]!;
    const others = g.members.filter((m) => m.docId !== anchor.docId).map((m) => m.docNumber || m.docId).join(", ");
    push({
      docId: anchor.docId,
      docNumber: anchor.docNumber,
      kind: g.kind,
      date: anchor.date,
      amount: g.amount,
      currency: g.currency,
      funcAmount: anchor.funcAmount,
      partyId: g.partyId,
      partyName: g.partyName,
      flagType: "duplicate",
      reason: strings.duplicateGroupReason({ count: g.count, currency: String(g.currency), amount: String(g.amount), sharedReference: g.sameReference && anchor.reference ? String(anchor.reference) : null, daysSpan: g.dateSpanDays, others }),
      riskScore: g.riskScore,
    });
  }
  for (const w of weekendItems) push(w);
  for (const r of rsfDisplay) push(r);
  for (const z of zDisplay) push(z);
  // Composite signal: duplicates + weekend + RSF + z-score + sequential-run
  // invoices (threshold-trap docs stay in their own tab, NOT in the aggregate).
  for (const s of sequential)
    for (const inv of s.invoices)
      push({ docId: inv.docId, docNumber: inv.docNumber, kind: "vendor_bill", date: inv.date, amount: inv.amount, currency: inv.currency, funcAmount: inv.funcAmount, partyId: s.partyId, partyName: s.partyName, flagType: "sequential", reason: s.reason, riskScore: s.riskScore });
  flagged.sort((a, b) => b.riskScore - a.riskScore);

  // …and the EXACT flagged union for the counts: every detector names each
  // flagged document once with its first-leg figure, deduplicated here and
  // translated once, so flaggedCount and totalAtRisk always cover everything
  // no matter where the display cuts fall. A document flagged twice carries
  // the same translated figure either way.
  const union = new Map<string, { funcAmt: string; func: string; date: string }>();
  const addUnion = (id: string, funcAmt: string, func: string, date: string): void => {
    if (!union.has(id)) union.set(id, { funcAmt, func, date });
  };
  for (const r of dupAnchorRows) {
    addUnion(
      String((r as { doc_id: string }).doc_id),
      String((r as { func_amt: string }).func_amt),
      String((r as { func_ccy: string }).func_ccy),
      String((r as { ddate: string }).ddate),
    );
  }
  for (const r of (weekendIds.rows as FlaggedIdRow[])) addUnion(r.doc_id, r.func_amount, r.func, r.date);
  for (const r of rsfFull) addUnion(r.id, r.func_amount, r.func, r.date);
  for (const r of zFull) addUnion(r.id, r.func_amount, r.func, r.date);
  for (const r of (seqIds.rows as FlaggedIdRow[])) addUnion(r.doc_id, r.func_amount, r.func, r.date);
  let totalAtRisk = "0.0000";
  for (const { funcAmt, func, date } of union.values()) {
    totalAtRisk = add(totalAtRisk, present(funcAmt, func, date));
  }
  const flaggedCount = union.size;

  // ---- Vendor risk roll-up (over the displayed findings, ranked top 50) -----
  const vendorRules = RISK_SCORING.vendor.rules;
  const vendorMap = new Map<string, SentinelData["vendorRisk"][number]>();
  for (const f of flagged) {
    const key = f.partyId ?? f.partyName ?? "unknown";
    let v = vendorMap.get(key);
    if (!v) { v = { partyId: f.partyId, partyName: strings.displayPartyName(f.partyName), flagCount: 0, totalAmount: "0.0000", flagTypes: [], maxRiskScore: 0, compositeScore: 0 }; vendorMap.set(key, v); }
    v.flagCount++;
    v.totalAmount = add(v.totalAmount, f.funcAmount);
    v.maxRiskScore = Math.max(v.maxRiskScore, f.riskScore);
    if (!v.flagTypes.includes(f.flagType)) v.flagTypes.push(f.flagType);
  }
  // Composite vendor score from the severity model, capped at 100.
  for (const v of vendorMap.values()) {
    const critical = setTier(vendorRules.tierCritical, cfg.aggregateHighAmount);
    const high = setTier(vendorRules.tierHigh, cfg.highRiskAmount);
    const amountTier =
      critical !== null && cmp(v.totalAmount, critical.threshold) >= 0 ? critical.points
      : high !== null && cmp(v.totalAmount, high.threshold) >= 0 ? high.points
      : vendorRules.tierBase.points;
    v.compositeScore = Math.min(100, Math.round(Math.min(v.flagCount * vendorRules.perFlag.perUnit, vendorRules.perFlag.cap) + amountTier + v.flagTypes.length * vendorRules.perType.points + v.maxRiskScore * vendorRules.worstShare.share));
  }
  const vendorRisk = [...vendorMap.values()].sort((a, b) => b.compositeScore - a.compositeScore || cmp(b.totalAmount, a.totalAmount)).slice(0, 50);

  // ---- Summary (risk points from the severity model) ------------------------------------------------------------
  const summaryRules = RISK_SCORING.summary.rules;
  let risk = 0;
  if (flaggedCount >= cfg.summaryFlaggedHigh) risk += summaryRules.flaggedHigh.points;
  else if (flaggedCount >= cfg.summaryFlaggedMedium) risk += summaryRules.flaggedMedium.points;
  if (cfg.aggregateCriticalAmount !== "" && cmp(dupAmount, cfg.aggregateCriticalAmount) > 0) risk += summaryRules.dupCritical.points;
  else if (cfg.aggregateHighAmount !== "" && cmp(dupAmount, cfg.aggregateHighAmount) > 0) risk += summaryRules.dupHigh.points;
  if (ghostCount > 0) risk += summaryRules.ghostAny.points;
  if (sequentialGroups > 0) risk += summaryRules.sequentialAny.points;
  if (deviating1D.length > 0) risk += summaryRules.benford.points;

  const topRiskAreas: SentinelData["summary"]["topRiskAreas"] = [];
  if (ghostCount) topRiskAreas.push({ severity: "critical", count: ghostCount, ...strings.riskGhosts(ghostCount) });
  if (sequentialGroups) topRiskAreas.push({ severity: "high", count: sequentialGroups, ...strings.riskSequential(sequentialGroups) });
  if (dupTotal > cfg.duplicateAreaMin) topRiskAreas.push({ severity: "high", count: dupTotal, ...strings.riskDuplicates(dupTotal) });
  if (trapTotal > 0) topRiskAreas.push({ severity: "high", count: trapTotal, ...strings.riskTraps(trapTotal) });
  if (deviating1D.length > 0) {
    topRiskAreas.push({
      severity: "medium",
      count: deviating1D.reduce((s, sl) => s + sl.totalTransactions, 0),
      ...strings.riskBenford(),
    });
  }
  topRiskAreas.sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] - { critical: 0, high: 1, medium: 2 }[b.severity]));

  const days = Math.round((end.getTime() - new Date(from + "T00:00:00Z").getTime()) / 86_400_000) + 1;

  return {
    scoring: RISK_SCORING,
    period,
    meta: { totalDocs: metaCount, totalAmount: metaTotal, presentationCurrency: presentationCcy, days, queryMs: Date.now() - t0 },
    config: cfg,
    summary: {
      flaggedCount,
      duplicateCount: dupTotal,
      totalDuplicateAmount: dupAmount,
      weekendCount: weekendTotal,
      weekendAmount: weekendTotalAmount,
      rsfCount: rsfFull.length,
      zScoreCount: zFull.length,
      sequentialGroups,
      ghostCount,
      trapCount: trapTotal,
      totalAtRisk,
      overallRiskScore: Math.min(100, risk),
      benfordConformity: b1Top.conformity,
      benford2DConformity: b2Top.conformity,
      approvalLimitRisk: flowLimits.length > 0 && trapTotal > 0,
      topRiskAreas,
      // The threshold trap is governed by Flows limits, not Configuration,
      // so it never joins this list: its unavailability is refused by name
      // on its own panel, where the remedy (a Flows amount condition) lives.
      // Everything named here is set in Sentinel → Configuration, which is
      // what the score note's single remedy promises.
      excludedDetectors: [
        ...(duplicateUnavailable !== null ? [strings.detectorDuplicate] : []),
        ...(rsfUnavailable !== null ? [strings.detectorRsf] : []),
        ...(zscoreUnavailable !== null ? [strings.detectorZscore] : []),
        ...(amountTierUnset ? [strings.detectorAmountTiers] : []),
      ],
    },
    duplicates: { total: dupTotal, pairs: dupPairsCapped, groups: dupGroups, unavailable: duplicateUnavailable },
    benford1D: { totalTransactions: total1D, digits: digits1D, mad: mad1D, conformity: b1Top.conformity, message: benfordMessage, byCurrency: b1Slices },
    benford2D: { totalTransactions: total2D, digits: digits2D, anomalies: anomalies2D, mad: mad2D, conformity: b2Top.conformity, byCurrency: b2Slices },
    thresholdTrap: { total: trapTotal, totalAmount: trapTotalAmount, byTrap: trapByTrap, items: trapItems, unavailable: trapUnavailable },
    weekend: { total: weekendTotal, totalAmount: weekendTotalAmount, saturday: satCount, sunday: sunCount, items: weekendItems },
    rsf: { total: rsfFull.length, items: rsfDisplay, unavailable: rsfUnavailable },
    zscore: { total: zFull.length, items: zDisplay, unavailable: zscoreUnavailable },
    sequential,
    ghosts,
    auditTrail: { total: auditTotal, deletes: auditDeletes, sensitiveChanges: auditSensitive, events: auditEvents },
    flagged: flagged.slice(0, 300),
    vendorRisk,
    calendar,
  };
}

/** Narrow summary shared by the Sentinel dashboard and the home-dashboard
 * risk widgets: one computation, never re-derived per surface. */
export interface SentinelRiskSummary {
  periodLabel: string;
  overallRiskScore: number;
  flaggedCount: number;
  /** Exact presentation-currency total at risk. */
  totalAtRisk: string;
  duplicateCount: number;
  /** Exact presentation-currency duplicate value at risk. */
  duplicateValue: string;
  duplicateConfigured: boolean;
  /** Translated reason naming the missing duplicate floor; null when configured. */
  duplicateUnavailableReason: string | null;
  /** Translated names of skipped Configuration-governed scoring sources (unset floors/tiers). */
  excludedDetectors: string[];
  presentationCurrency: string;
}

export async function sentinelRiskSummary(
  orgId: string,
  period: { from: string; to: string; label: string },
  authz: Authz,
  strings: SentinelStrings = sentinelStrings(englishCatalogMessage, "en"),
): Promise<SentinelRiskSummary> {
  const data = await sentinelData(orgId, period, authz, strings);
  return {
    periodLabel: data.period.label,
    overallRiskScore: data.summary.overallRiskScore,
    flaggedCount: data.summary.flaggedCount,
    totalAtRisk: data.summary.totalAtRisk,
    duplicateCount: data.summary.duplicateCount,
    duplicateValue: data.summary.totalDuplicateAmount,
    duplicateConfigured: data.duplicates.unavailable === null,
    duplicateUnavailableReason: data.duplicates.unavailable,
    excludedDetectors: data.summary.excludedDetectors,
    presentationCurrency: data.meta.presentationCurrency,
  };
}
