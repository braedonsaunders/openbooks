import {
  accrualEarned,
  carryoverApplied,
} from "@openbooks/engine/src/hrm/leave-math.ts";
import { UUID_RE } from "./coerce.ts";

/**
 * HRM leave-policy rule normalization (pure — no server imports, so unit
 * tests run it directly like hrm-process-template.ts).
 *
 * The Setup drawer edits the three rule jsonb columns through structured
 * controls backed by STORED GENERATED columns (readable for prefill, never
 * written): two ref slots for the applies_to scope (empty means all), a
 * select plus two numeric slots for the accrual rule, and a select plus two
 * numeric slots for the carryover rule. This fold runs before buildRow on
 * both create and edit so the virtual slot keys never reach the column
 * writer; the folded jsonb objects are persisted explicitly in write.ts
 * (buildRow only emits declared fields) and the shape proofs stay in
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

const APPLIES_SLOTS = ["appliesEmployerSubsidiaryId", "appliesDepartmentId"] as const;
const ACCRUAL_SLOTS = ["accrualKind", "accrualHours", "accrualPeriodsPerYear"] as const;
const CARRYOVER_SLOTS = ["carryoverKind", "carryoverHours", "carryoverExpiresAfterDays"] as const;

const ACCRUAL_KINDS = ["none", "per_period", "per_year", "unlimited"] as const;
const CARRYOVER_KINDS = ["none", "carry_all", "carry_up_to"] as const;

function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function idSlot(value: unknown): string | null {
  if (blank(value)) return null;
  return String(value);
}

/** Fold a numeric slot: clean integers cross as numbers, anything else rides
 *  through so the shape probe refuses it with the engine's words instead of
 *  this fold inventing its own. */
function intSlot(value: unknown): unknown {
  if (blank(value)) return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) ? n : value;
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
export function leavePolicyRuleProblem(values: LeavePolicyRuleValues): string | null {
  if (values.appliesTo !== undefined) {
    const raw = values.appliesTo;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return "The applies-to filter must be a JSON object";
    }
    const record = raw as Record<string, unknown>;
    for (const key of ["employer_subsidiary_id", "department_id"] as const) {
      const entry = record[key] ?? null;
      if (entry !== null && (typeof entry !== "string" || !UUID_RE.test(entry))) {
        return "The applies-to subsidiary and department must be ids, or null for all";
      }
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
      if (!Number.isInteger(record.expires_after_days) || (record.expires_after_days as number) < 0) {
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

export function normalizeHrmLeavePolicyInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== "leave-policies") return body;
  const hasSlot = (keys: readonly string[]): boolean => keys.some((key) => body[key] !== undefined);
  if (!hasSlot(APPLIES_SLOTS) && !hasSlot(ACCRUAL_SLOTS) && !hasSlot(CARRYOVER_SLOTS)) return body;
  const out: Record<string, unknown> = { ...body };
  if (hasSlot(APPLIES_SLOTS)) {
    // Slot keys win over a direct object, the way the process-template fold
    // does: the drawer always sends the complete slot set it offered.
    out.appliesTo = {
      employer_subsidiary_id: idSlot(body.appliesEmployerSubsidiaryId),
      department_id: idSlot(body.appliesDepartmentId),
    };
  }
  if (hasSlot(ACCRUAL_SLOTS)) {
    const rule: Record<string, unknown> = {
      kind: blank(body.accrualKind) ? "none" : String(body.accrualKind),
    };
    if (!blank(body.accrualHours)) rule.hours = String(body.accrualHours).trim();
    const periods = intSlot(body.accrualPeriodsPerYear);
    if (periods !== undefined) rule.periods_per_year = periods;
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
  // hrm-rule-slots.ts strips their generated columns from whatever buildRow
  // emits for the declared slot fields, so nothing generated is written.
  for (const key of [...APPLIES_SLOTS, ...ACCRUAL_SLOTS, ...CARRYOVER_SLOTS]) delete out[key];
  // The fold never throws: the shape refusal is raised by
  // validateEntityIntegrity in write.ts through leavePolicyRuleProblem, so
  // the caller receives a 400 with the engine's words, not an exception.
  return out;
}
