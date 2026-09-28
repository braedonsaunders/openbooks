import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { civilDateFromParts, daysInCivilMonth } from "../platform/civil-date.ts";

type Runner = Pick<typeof db, "execute">;

/**
 * Doctrine shared by every reader in this file: the authoritative source is
 * the `fx_rates` table (`rate_type = 'spot'`), read direct-or-inverse. The
 * `consolidated_fx_rates` table is never consulted here — a manual
 * consolidated override changes consolidation output, never the rate evidence
 * below.
 */
export const SPOT_EVIDENCE_POLICY = "direct-or-inverse-spot";
export const SPOT_EVIDENCE_TABLE = "fx_rates";

export type FxEvidenceDirection = "direct" | "inverse";

/** One selected `fx_rates` row, expressed in the requested direction. */
export interface FxObservationEvidence {
  /** Storage identity of the selected row. */
  id: string;
  /** Quoted date of the selected row. */
  asOf: string;
  /** Stored source of the selected row (`manual` rows are authoritative). */
  source: string;
  /** Rate exactly as stored (un-inverted). */
  storedRate: string;
  /** Last-write stamp of the selected row, UTC ISO. */
  updatedAt: string;
  /** Whether the requested pair used the row directly or inverted. */
  direction: FxEvidenceDirection;
  /** Rate in the requested direction — the value that priced the result. */
  derivedRate: string;
}

interface FxEvidenceBase {
  from: string;
  to: string;
  /** Rating doctrine that selected the observations. */
  policy: typeof SPOT_EVIDENCE_POLICY;
  /** Authoritative table the observations were read from. */
  table: typeof SPOT_EVIDENCE_TABLE;
  /**
   * True when the pair is one currency quoted against itself: the rate is
   * exact par by definition, with no database row behind it.
   */
  sameCurrencyPar: boolean;
  /** Exact result priced by the observations (`null` when uncovered). */
  rate: string | null;
  /**
   * Full canonical selected observation set in `as_of` ascending order:
   * the single winning row for an as-of lookup, the per-date winners for a
   * month average. Empty for same-currency par and for uncovered windows.
   */
  observations: FxObservationEvidence[];
  /**
   * SHA-256 over the canonical payload (pair, scope, policy, table and the
   * full observation set above), so the exact result stays reproducible from
   * the evidence after provider rows later change.
   */
  digest: string;
}

export interface FxAsOfEvidence extends FxEvidenceBase {
  kind: "as-of";
  asOf: string;
}

export interface FxMonthAverageEvidence extends FxEvidenceBase {
  kind: "calendar-month-average";
  year: number;
  month: number;
  monthStart: string;
  monthEnd: string;
}

/**
 * Shared direct-or-inverse spot candidate set for one currency pair: the
 * direct quotes plus the inverted reverse quotes, each tagged with its
 * precedence (direct 0 beats inverse 1). Both readers below build on this
 * fragment so the per-date precedence cannot drift between them.
 *
 * The fx_rates unique index on (org, pair, as_of, rate_type) allows at most
 * one stored row per direction per date, so the 0/1 priority fully determines
 * the per-date winner — no created_at/id tiebreak exists or is needed.
 */
/**
 * Same candidate set as above, but every row carries its storage identity so
 * evidence can name the exact observation behind a result. The per-date
 * winner is unchanged: direct (priority 0) beats inverse (priority 1), and
 * the unique index on (org, pair, as_of, rate_type) leaves no further tie.
 */
function spotEvidenceCandidates(orgId: string, from: string, to: string, dateCond: SQL): SQL {
  return sql`
    select id::text as id, as_of, source, rate::text as stored_rate,
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
           0 as priority, rate::text as derived_rate from fx_rates
     where org_id = ${orgId} and from_currency = ${from}
       and to_currency = ${to} and rate_type = 'spot'
       and ${dateCond}
    union all
    select id::text as id, as_of, source, rate::text as stored_rate,
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
           1 as priority, (1 / rate)::numeric(19,10)::text as derived_rate from fx_rates
     where org_id = ${orgId} and from_currency = ${to}
       and to_currency = ${from} and rate_type = 'spot'
       and ${dateCond}`;
}

// Object-literal row shape (not an interface): it satisfies drizzle's
// `Record<string, unknown>` generic constraint on execute while keeping
// every selected column strongly typed — no casts, no any.
type EvidenceRow = {
  id: string;
  as_of: string;
  source: string;
  stored_rate: string;
  updated_at: string;
  priority: number;
  derived_rate: string;
};

function toObservation(row: EvidenceRow): FxObservationEvidence {
  return {
    id: row.id,
    asOf: typeof row.as_of === "string" ? row.as_of.slice(0, 10) : String(row.as_of),
    source: row.source,
    storedRate: row.stored_rate,
    updatedAt: row.updated_at,
    direction: Number(row.priority) === 0 ? "direct" : "inverse",
    derivedRate: row.derived_rate,
  };
}

/** Canonical digest over the exact payload the result was priced from. */
function evidenceDigest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function digestObservations(
  kind: string,
  scope: Record<string, unknown>,
  from: string,
  to: string,
  rate: string | null,
  observations: FxObservationEvidence[],
): string {
  return evidenceDigest({
    v: 1,
    kind,
    from,
    to,
    scope,
    policy: SPOT_EVIDENCE_POLICY,
    table: SPOT_EVIDENCE_TABLE,
    rate,
    observations,
  });
}

function sameCurrencyDigest(
  kind: string,
  scope: Record<string, unknown>,
  currency: string,
): string {
  return evidenceDigest({
    v: 1,
    kind,
    from: currency,
    to: currency,
    scope,
    policy: SPOT_EVIDENCE_POLICY,
    table: SPOT_EVIDENCE_TABLE,
    sameCurrencyPar: true,
    rate: "1",
    observations: [],
  });
}

/**
 * Exact calendar-month bounds for a month average. The window is always the
 * calendar month — an accounting period that starts or ends mid-month never
 * narrows or widens it.
 */
export function fxCalendarMonthBounds(year: number, month: number): { monthStart: string; monthEnd: string } {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid calendar month ${year}-${month}: pass a 1-12 month`);
  }
  const monthStart = civilDateFromParts(year, month, 1);
  const monthEnd = civilDateFromParts(year, month, daysInCivilMonth(year, month));
  return { monthStart, monthEnd };
}

/**
 * As-of spot with evidence: the newest `fx_rates` spot row on or before the
 * date, direct-or-inverse, plus the full canonical observation behind the
 * result. Same-currency pairs return exact par with an empty observation set.
 * Returns a null rate (never a fallback) when the pair is uncovered — the
 * caller refuses with its own message.
 */
export async function lookupSpotRateWithEvidence(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  asOf: string,
): Promise<FxAsOfEvidence> {
  const base = {
    from,
    to,
    policy: SPOT_EVIDENCE_POLICY,
    table: SPOT_EVIDENCE_TABLE,
    sameCurrencyPar: false,
  } as const;
  if (from === to) {
    return {
      ...base,
      sameCurrencyPar: true,
      kind: "as-of",
      asOf,
      rate: "1",
      observations: [],
      digest: sameCurrencyDigest("as-of", { asOf }, from),
    };
  }
  const candidates = spotEvidenceCandidates(orgId, from, to, sql`as_of <= ${asOf}`);
  const r = await runner.execute<EvidenceRow>(sql`
    select id, as_of::text as as_of, source, stored_rate, updated_at, priority, derived_rate
      from (${candidates}) candidates
     order by as_of desc, priority asc limit 1`);
  const row = r.rows[0];
  if (!row) {
    return {
      ...base,
      kind: "as-of",
      asOf,
      rate: null,
      observations: [],
      digest: digestObservations("as-of", { asOf }, from, to, null, []),
    };
  }
  const observations = [toObservation(row)];
  const rate = observations[0]!.derivedRate;
  return {
    ...base,
    kind: "as-of",
    asOf,
    rate,
    observations,
    digest: digestObservations("as-of", { asOf }, from, to, rate, observations),
  };
}

/**
 * Exact calendar-month-average spot with evidence: one observation per quoted
 * date in the month (direct wins shared dates), the mean over those derived
 * rates, and the full canonical per-date observation set. Same-currency pairs
 * return exact par. A quoteless month returns a null rate with no
 * closing/current fallback — the caller refuses.
 */
/**
 * Single window-averaging core shared by the month evidence helper and the
 * scalar wrapper below, so the per-date precedence and the mean cannot drift
 * between them: ONE observation per as_of date contributes — the direct quote
 * wins when a date is quoted in both directions — and the mean is taken over
 * those derived rates in SQL numeric arithmetic, never JS floating point.
 */
async function selectWindowObservations(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  fromDate: string,
  toDate: string,
): Promise<{ observations: FxObservationEvidence[]; average: string | null }> {
  const candidates = spotEvidenceCandidates(orgId, from, to, sql`as_of between ${fromDate} and ${toDate}`);
  const r = await runner.execute<EvidenceRow & { average: string | null }>(sql`
    with per_date as (
      select distinct on (as_of) id, as_of, source, stored_rate, updated_at, priority, derived_rate
        from (${candidates}) candidates
       order by as_of, priority asc
    )
    select id, as_of::text as as_of, source, stored_rate, updated_at, priority, derived_rate,
           (select avg(derived_rate::numeric)::numeric(19,10)::text from per_date) as average
      from per_date
     order by as_of asc, id asc`);
  const observations = r.rows.map(toObservation);
  return { observations, average: observations.length === 0 ? null : (r.rows[0]!.average ?? null) };
}

/**
 * Exact calendar-month-average spot with evidence: one observation per quoted
 * date in the month (direct wins shared dates), the mean over those derived
 * rates, and the full canonical per-date observation set. Same-currency pairs
 * return exact par. A quoteless month returns a null rate with no
 * closing/current fallback — the caller refuses.
 */
export async function averageSpotRateForMonthWithEvidence(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  year: number,
  month: number,
): Promise<FxMonthAverageEvidence> {
  const { monthStart, monthEnd } = fxCalendarMonthBounds(year, month);
  const scope = { year, month, monthStart, monthEnd };
  const base = {
    from,
    to,
    policy: SPOT_EVIDENCE_POLICY,
    table: SPOT_EVIDENCE_TABLE,
    sameCurrencyPar: false,
  } as const;
  if (from === to) {
    return {
      ...base,
      sameCurrencyPar: true,
      kind: "calendar-month-average",
      ...scope,
      rate: "1",
      observations: [],
      digest: sameCurrencyDigest("calendar-month-average", scope, from),
    };
  }
  const { observations, average } = await selectWindowObservations(runner, orgId, from, to, monthStart, monthEnd);
  return {
    ...base,
    kind: "calendar-month-average",
    ...scope,
    rate: average,
    observations,
    digest: digestObservations("calendar-month-average", scope, from, to, average, observations),
  };
}

/**
 * Spot-rate lookup shared by the posting kernel, period-close derivation and
 * statement translation (direct-or-inverse, `rate_type = 'spot'`).
 *
 * When the direct pair and an inverted quote share the newest as_of, the
 * DIRECT row wins (priority 0 beats 1): provider syncs write every directed
 * pair per date, and double rounding can separate the candidates by a unit,
 * so one pair/date must always convert alike. Returns null when the pair is
 * uncovered on/before the date — callers fail closed with their own refusal,
 * never a silent mix or a defaulted 1.
 */
export async function lookupSpotRate(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  asOf: string,
): Promise<string | null> {
  return (await lookupSpotRateWithEvidence(runner, orgId, from, to, asOf)).rate;
}

/**
 * Mean spot over a date window under the same direct-or-inverse doctrine,
 * delegated to the shared window core behind the month evidence helper so
 * the two can never price one window two ways: ONE observation per as_of
 * date contributes — the direct quote wins when a date is quoted in both
 * directions, otherwise the inverted reverse quote. Without the per-date
 * collapse a date quoted both ways would count twice and skew the mean
 * toward itself. Null when the window holds no quote in either direction
 * (callers fall back to the closing spot, exactly as a quote-free window
 * did before).
 */
export async function averageSpotRate(
  runner: Runner,
  orgId: string,
  from: string,
  to: string,
  fromDate: string,
  toDate: string,
): Promise<string | null> {
  if (from === to) return "1";
  return (await selectWindowObservations(runner, orgId, from, to, fromDate, toDate)).average;
}
