import { accrualEarned, carryoverApplied } from "@openbooks/engine/hrm/leave-math";
import {} from "./coerce.ts";
import { foldWholeNumber } from "./whole-number";
import { isUuid } from "@openbooks/engine/platform/identifiers";

/**
 * HRM leave-policy rule normalization (pure — no server imports, so unit
 * tests run it directly like hrm-process-template.ts).
 *
 * The Setup drawer edits the three rule jsonb columns through structured
 * controls backed by STORED GENERATED columns (readable for prefill, never
 * written): two ref slots plus two id-picker slots for the applies_to scope
 * (empty means all), a select plus two numeric slots plus the service-tier
 * table for the accrual rule, and a select plus two numeric slots for the
 * carryover rule. Picker and tier slots have no generated projection, so
 * they prefill through projectRuleSlotPrefills straight off the stored
 * jsonb. This fold runs before buildRow on both create and edit so the
 * virtual slot keys never reach the column writer; the folded jsonb
 * objects are persisted explicitly in write.ts (buildRow only emits
 * declared fields) and the shape proofs stay in
 * validateEntityIntegrity.
 *
 * Refused shapes throw with the engine's own words: the accrual and
 * carryover probes below call the engine's rule math directly
 * (accrualEarned, carryoverApplied), so a per_year or per_period rule
 * without hours, a per_period rule without periods_per_year, and a
 * carry_up_to rule without hours fail here exactly as they fail at the
 * balance read — never as a silent nil. The kind allowlists and the
 * expires_after_days bound are the engine write path's words
 * (engine/src/hrm/leave.ts validateAccrualRule/validateCarryoverRule);
 * the applies-to shape messages match the hrm-process-templates drawer.
 */

// Fixed probe dates: equal start and as-of means zero elapsed periods, so
// the probe is sensitive only to rule shape, never to the calendar.
const PROBE_DATE = "2000-01-01";

const APPLIES_SLOTS = [
  "appliesEmployerSubsidiaryId",
  "appliesDepartmentId",
  "appliesEmploymentIds",
  "appliesClassificationIds",
] as const;
const ACCRUAL_SLOTS = ["accrualKind", "accrualHours", "accrualPeriodsPerYear"] as const;
const ACCRUAL_TIERS_SLOT = "accrualTiers";
const CARRYOVER_SLOTS = ["carryoverKind", "carryoverHours", "carryoverExpiresAfterDays"] as const;

const ACCRUAL_KINDS = ["none", "per_period", "per_year", "unlimited"] as const;
const CARRYOVER_KINDS = ["none", "carry_all", "carry_up_to"] as const;

function blank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

function idSlot(value: unknown): string | null {
  if (blank(value)) return null;
  return String(value);
}

/** Whole-number slots fold through the shared normalizer (see coerce.ts):
 *  clean integers cross as numbers, anything else rides through so the
 *  shape probe refuses it with the engine's words instead of this fold
 *  inventing its own. */
function intSlot(value: unknown): unknown {
  return foldWholeNumber(value);
}

export interface LeavePolicyRuleValues {
  readonly appliesTo?: unknown;
  readonly accrualRule?: unknown;
  readonly carryoverRule?: unknown;
}

/**
 * The shape problem in merged rule values, if any. Pure so both the drawer
 * fold (which throws) and the write-path integrity check (which returns)
 * refuse the same shapes with the same words.
 */
/**
 * Targeted id lists: null/undefined means all; otherwise a non-empty list
 * of uuids. Words mirror the engine write path (validateAppliesIdList)
 * so the drawer and the API refuse the same shapes with the same message.
 */
function targetListProblem(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return `The applies-to ${field} must be a non-empty list of ids, or null for all`;
  }
  for (const entry of value) {
    if (!isUuid(entry)) return `The applies-to ${field} must be ids, or null for all`;
  }
  return null;
}

/**
 * Service tiers: a non-empty list of {after_years, hours} with strictly
 * ascending positive thresholds. Words mirror the engine write path
 * (validateAccrualTiers) so the drawer and the API refuse the same
 * shapes with the same message.
 */
function accrualTiersProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return "accrual_rule.tiers is a non-empty list of {after_years, hours} — record the tiers or omit them";
  }
  let previous = -1;
  for (const tier of value) {
    if (typeof tier !== "object" || tier === null || Array.isArray(tier)) {
      return "accrual_rule.tiers entries carry after_years and hours — record each tier";
    }
    const record = tier as Record<string, unknown>;
    if (!Number.isInteger(record.after_years) || (record.after_years as number) < 1) {
      return "accrual_rule.tiers after_years is a positive whole number of completed service years — record each tier's threshold";
    }
    if (typeof record.hours !== "string") {
      return "accrual_rule.tiers hours is an exact decimal — record each tier's hours";
    }
    try {
      accrualEarned(
        { kind: "per_year", hours: record.hours } as Parameters<typeof accrualEarned>[0],
        PROBE_DATE,
        PROBE_DATE,
      );
    } catch {
      return "accrual_rule.tiers hours is an exact decimal with at most 2 fraction digits — record each tier's hours";
    }
    if (record.hours.trim() === "" || Number(record.hours) <= 0) {
      return "accrual_rule.tiers.hours must be greater than zero";
    }
    if ((record.after_years as number) <= previous) {
      return "accrual_rule.tiers after_years ascends strictly — order the tiers by completed service years";
    }
    previous = record.after_years as number;
  }
  return null;
}

export function leavePolicyRuleProblem(values: LeavePolicyRuleValues): string | null {
  if (values.appliesTo !== undefined) {
    const raw = values.appliesTo;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return "The applies-to filter must be a JSON object";
    }
    const record = raw as Record<string, unknown>;
    for (const key of ["employer_subsidiary_id", "department_id"] as const) {
      const entry = record[key] ?? null;
      if (entry !== null && !isUuid(entry)) {
        return "The applies-to subsidiary and department must be ids, or null for all";
      }
    }
    for (const [prop, field] of [
      ["employment_ids", "employments"],
      ["classification_ids", "classifications"],
    ] as const) {
      const problem = targetListProblem(record[prop], field);
      if (problem) return problem;
    }
  }
  if (values.accrualRule !== undefined) {
    const raw = values.accrualRule;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return "accrual_rule declares kind none, per_period, per_year, or unlimited — record the rule";
    }
    const record = raw as Record<string, unknown>;
    if (!(ACCRUAL_KINDS as readonly unknown[]).includes(record.kind)) {
      return "accrual_rule kind is one of none, per_period, per_year, unlimited — record the rule";
    }
    if (
      record.tiers !== undefined &&
      record.tiers !== null &&
      record.kind !== "per_year" &&
      record.kind !== "per_period"
    ) {
      return `a ${String(record.kind)} accrual rule carries no hours, so tiers have nothing to lift — use kind per_year or per_period for service-based tiers`;
    }
    const tiersProblem = accrualTiersProblem(record.tiers);
    if (tiersProblem) return tiersProblem;
    try {
      accrualEarned(
        record as unknown as Parameters<typeof accrualEarned>[0],
        PROBE_DATE,
        PROBE_DATE,
      );
    } catch (e) {
      return e instanceof Error ? e.message : "invalid accrual rule";
    }
  }
  if (values.carryoverRule !== undefined) {
    const raw = values.carryoverRule;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return "carryover_rule declares kind none, carry_all, or carry_up_to — record the rule";
    }
    const record = raw as Record<string, unknown>;
    if (!(CARRYOVER_KINDS as readonly unknown[]).includes(record.kind)) {
      return "carryover_rule kind is one of none, carry_all, carry_up_to — record the rule";
    }
    if (record.expires_after_days !== undefined && record.expires_after_days !== null) {
      if (
        !Number.isInteger(record.expires_after_days) ||
        (record.expires_after_days as number) < 0
      ) {
        return "carryover expires_after_days is a non-negative integer of days — record the expiry";
      }
    }
    try {
      carryoverApplied(
        record as unknown as Parameters<typeof carryoverApplied>[0],
        "1",
        PROBE_DATE,
        PROBE_DATE,
      );
    } catch (e) {
      return e instanceof Error ? e.message : "invalid carryover rule";
    }
  }
  return null;
}

/**
 * Targeted id slots: an empty selection means all (null), matching the
 * subsidiary/department empty-means-all convention. Values ride through
 * untouched for the integrity check to refuse with the engine's words.
 */
function idListSlot(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return value as unknown as string[];
  const ids = [
    ...new Set(value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)),
  ];
  return ids.length === 0 ? null : ids;
}

/**
 * Service-tier rows: drawer items carry snake_case props (after_years,
 * hours), the same shape the stored tiers keep. The fold never throws —
 * malformed rows ride through for validateEntityIntegrity to refuse.
 */
function tiersSlot(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return value as unknown as unknown[];
  if (value.length === 0) return undefined;
  // Malformed rows ride through untouched for validateEntityIntegrity to
  // refuse — the fold drops nothing it was given.
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const years = record.after_years ?? record.afterYears;
    const hours = record.hours;
    return {
      after_years: years,
      hours: typeof hours === "string" ? hours.trim() : hours,
    };
  });
}

export function normalizeHrmLeavePolicyInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== "leave-policies") return body;
  const hasSlot = (keys: readonly string[]): boolean => keys.some((key) => body[key] !== undefined);
  if (
    !hasSlot(APPLIES_SLOTS) &&
    !hasSlot(ACCRUAL_SLOTS) &&
    body[ACCRUAL_TIERS_SLOT] === undefined &&
    !hasSlot(CARRYOVER_SLOTS)
  ) {
    return foldDirectRuleNumerics(body);
  }
  const out: Record<string, unknown> = { ...body };
  if (hasSlot(APPLIES_SLOTS)) {
    // Slot keys win over a direct object, the way the process-template fold
    // does: the drawer always sends the complete slot set it offered.
    out.appliesTo = {
      employer_subsidiary_id: idSlot(body.appliesEmployerSubsidiaryId),
      department_id: idSlot(body.appliesDepartmentId),
      employment_ids: idListSlot(body.appliesEmploymentIds),
      classification_ids: idListSlot(body.appliesClassificationIds),
    };
  }
  if (hasSlot(ACCRUAL_SLOTS) || body[ACCRUAL_TIERS_SLOT] !== undefined) {
    const rule: Record<string, unknown> = {
      kind: blank(body.accrualKind) ? "none" : String(body.accrualKind),
    };
    if (!blank(body.accrualHours)) rule.hours = String(body.accrualHours).trim();
    const periods = intSlot(body.accrualPeriodsPerYear);
    if (periods !== undefined) rule.periods_per_year = periods;
    const tiers = tiersSlot(body[ACCRUAL_TIERS_SLOT]);
    if (tiers !== undefined) rule.tiers = tiers;
    out.accrualRule = rule;
  }
  if (hasSlot(CARRYOVER_SLOTS)) {
    const rule: Record<string, unknown> = {
      kind: blank(body.carryoverKind) ? "none" : String(body.carryoverKind),
    };
    if (!blank(body.carryoverHours)) rule.hours = String(body.carryoverHours).trim();
    const expires = intSlot(body.carryoverExpiresAfterDays);
    if (expires !== undefined) rule.expires_after_days = expires;
    out.carryoverRule = rule;
  }
  // The slot keys never reach the column writer: they are folded above and
  // hrm-rule-slots.ts strips their generated columns (and skips the folded
  // array slots through coveredSlotFields) from whatever buildRow emits for
  // the declared slot fields, so nothing generated is written.
  for (const key of [...APPLIES_SLOTS, ...ACCRUAL_SLOTS, ACCRUAL_TIERS_SLOT, ...CARRYOVER_SLOTS])
    delete out[key];
  // The fold never throws: the shape refusal is raised by
  // validateEntityIntegrity in write.ts through leavePolicyRuleProblem, so
  // the caller receives a 400 with the engine's words, not an exception.
  return foldDirectRuleNumerics(out);
}

/**
 * Direct rule objects (API and import callers, no drawer slots) carry the
 * same raw strings the text inputs send: fold their whole-number members
 * through the shared normalizer so the probe refuses the folded value,
 * never the transport spelling. Idempotent over the slot folds, and
 * reference-preserving when nothing folds.
 */
function foldDirectRuleNumerics(body: Record<string, unknown>): Record<string, unknown> {
  let out = body;
  for (const [ruleKey, member] of [
    ["accrualRule", "periods_per_year"],
    ["carryoverRule", "expires_after_days"],
  ] as const) {
    const rule = out[ruleKey];
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
    const record = rule as Record<string, unknown>;
    if (record[member] === undefined) continue;
    const folded = foldWholeNumber(record[member]);
    if (folded === record[member]) continue;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== member) next[key] = value;
    }
    if (folded !== undefined) next[member] = folded;
    if (out === body) out = { ...body };
    out[ruleKey] = next;
  }
  return out;
}
