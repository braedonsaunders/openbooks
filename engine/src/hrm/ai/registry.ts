import { featureEnabled, type FeatureState } from "../../organization/feature-registry.ts";
import { autonomyRaiseRefused, unknownCapability } from "./errors.ts";

/**
 * AI capability registry. Every AI capability is a TOOL or a DETERMINISTIC
 * service; the registry is the single source of truth the org mirror
 * (ai_capabilities), the assistant prompts, and the ledger sync all read
 * from. Capability keys are stable identifiers recorded on every ledger
 * row — they are not feature switches. Each capability rides the module
 * that owns its data (`featureKey`); there is no separate AI switch.
 *
 * Autonomy ladder (ascending): read_only < draft < propose <
 * act_with_confirmation. There is no autonomous level — the code maximum
 * is act_with_confirmation and an org may only edit autonomy DOWN.
 */

export const AI_AUTONOMY_LADDER = [
  "read_only",
  "draft",
  "propose",
  "act_with_confirmation",
] as const;

export type AiAutonomy = (typeof AI_AUTONOMY_LADDER)[number];

export interface AiCapabilityDef {
  /** Stable capability identifier (ledger rows, the org mirror, tools). */
  readonly key: string;
  readonly name: string;
  readonly purpose: string;
  /** Tables/tools the capability reads. */
  readonly dataScope: readonly string[];
  /** Code maximum autonomy — orgs may only lower it. */
  readonly maxAutonomy: AiAutonomy;
  /** Role expected to review the capability on its cadence. */
  readonly reviewerRole: string;
  /** Regulatory subjects must be told (EU AI Act Annex III, Illinois HB 3773). */
  readonly noticeRequired: boolean;
  /** Notice shown to subjects. Never empty when noticeRequired. */
  readonly noticeText: string;
  /**
   * Module feature that gates the capability — the module owning the data
   * it reads. Null when the capability has no module of its own and only
   * follows the assistant's gating (the `assistant.use` permission and the
   * model configuration).
   */
  readonly featureKey: string | null;
  /** One prompt line appended to the assistant system prompt while on. */
  readonly promptLine: string;
}

const DEFINITIONS: readonly AiCapabilityDef[] = [
  {
    key: "hrmExplainPay",
    name: "Explain my pay",
    purpose: "Render a deterministic payslip trace (components, inputs, deductions, diff vs previous) in prose.",
    dataScope: ["pay_stubs", "pay_stub_lines", "pay_components", "hrm_payroll_inputs", "pay_run_benefit_allocations", "labor_cost_rates"],
    maxAutonomy: "read_only",
    reviewerRole: "payroll administrator",
    noticeRequired: true,
    noticeText: "Pay explanations are generated from your payroll records. The figures come from the deterministic payroll calculation; the wording is AI-generated and the numbers govern.",
    featureKey: "payroll",
    promptLine: "hrmExplainPay (read-only): explain payslips from the deterministic trace only, citing record ids; never reveal another person's pay.",
  },
  {
    key: "hrmPayrollAnomalies",
    name: "Payroll checks",
    purpose: "Deterministic pre-run anomaly scan; block severity refuses the pay-run commit while open.",
    dataScope: ["pay_stubs", "hrm_payroll_inputs", "pay_run_benefit_allocations", "party_bank_accounts", "labor_cost_rates", "payroll_anomaly_flags"],
    maxAutonomy: "propose",
    reviewerRole: "payroll administrator",
    noticeRequired: true,
    noticeText: "Pre-run payroll checks flag unusual figures for human review. A flag is a question, never a decision: a person resolves every flag before the run is finalized.",
    featureKey: "payroll",
    promptLine: "hrmPayrollAnomalies (propose): surface payroll check flags with their numbers; never clear or resolve a flag yourself.",
  },
  {
    key: "hrmTimeAnomalies",
    name: "Timesheet checks",
    purpose: "Deterministic timesheet anomaly flags shown on approvals and inbox items.",
    dataScope: ["time_entries", "timesheet_weeks", "payroll_anomaly_flags"],
    maxAutonomy: "propose",
    reviewerRole: "payroll administrator",
    noticeRequired: true,
    noticeText: "Timesheet checks flag unusual entries for the approver. A flag is a question for a person, never an automated rejection.",
    featureKey: "timeTracking",
    promptLine: "hrmTimeAnomalies (propose): surface timesheet flags with their numbers; approval stays with the human approver.",
  },
  {
    key: "hrmDrafting",
    name: "Evidence-grounded drafting",
    purpose: "Draft job descriptions, reviews, onboarding plans and offer clauses from records the actor may read. Drafts never auto-submit.",
    dataScope: ["hrm_requisitions", "hrm_reviews", "hrm_processes", "hrm_requisitions:offers"],
    maxAutonomy: "draft",
    reviewerRole: "HR manager",
    noticeRequired: true,
    noticeText: "AI drafts are starting points assembled from your records. A person reviews, edits and submits every word — nothing is filed automatically.",
    featureKey: "hrm",
    promptLine: "hrmDrafting (draft): draft only from the cited sources, list every source, flag biased language; never submit or file anything.",
  },
  {
    key: "hrmNlReports",
    name: "Natural-language reports",
    purpose: "Turn a question into a validated report-engine definition (never SQL) with a preview, saved only as a view.",
    dataScope: ["report_definitions"],
    maxAutonomy: "draft",
    reviewerRole: "system administrator",
    noticeRequired: true,
    noticeText: "Report definitions from plain-language questions are validated against your report permissions and previewed before saving. The question is interpreted, never executed as written.",
    featureKey: null,
    promptLine: "hrmNlReports (draft): produce report definitions inside the caller's report permissions; invalid definitions are refused, never repaired silently.",
  },
  {
    key: "aiGovernanceLedger",
    name: "AI governance ledger",
    purpose: "Capability registry mirror, decision log, notice catalogue and review cadence for every AI capability.",
    dataScope: ["ai_capabilities", "ai_decisions"],
    maxAutonomy: "read_only",
    reviewerRole: "system administrator",
    noticeRequired: true,
    noticeText: "Every AI-assisted answer is logged with its sources. The ledger records that the AI helped — a person made the decision.",
    featureKey: "aiGovernanceLedger",
    promptLine: "aiGovernanceLedger (read-only): every AI-assisted answer is logged with its sources; the ledger is the record.",
  },
];

export const AI_CAPABILITIES: ReadonlyMap<string, AiCapabilityDef> = new Map(
  DEFINITIONS.map((def) => [def.key, def]),
);

/**
 * Whether a capability is available under the org's feature state: its
 * module feature is on, or it has no module gate of its own.
 */
export function capabilityFeatureOn(features: FeatureState, def: AiCapabilityDef): boolean {
  return def.featureKey === null || featureEnabled(features, def.featureKey);
}

/** Position on the ladder; unknown autonomy sorts below read_only. */
export function autonomyRank(autonomy: string): number {
  const rank = AI_AUTONOMY_LADDER.indexOf(autonomy as AiAutonomy);
  return rank < 0 ? -1 : rank;
}

/** Assert the definition exists; unknown keys refuse with the remedy. */
export function requireCapability(key: string): AiCapabilityDef {
  const def = AI_CAPABILITIES.get(key);
  if (!def) throw unknownCapability(key);
  return def;
}

/**
 * Assert a requested autonomy is at or below the code maximum. Raises are
 * refused by name — the ledger service enforces this on every PATCH.
 */
export function assertAutonomyAtOrBelowMax(key: string, requested: string): void {
  const def = requireCapability(key);
  if (autonomyRank(requested) < 0 || autonomyRank(requested) > autonomyRank(def.maxAutonomy)) {
    throw autonomyRaiseRefused(key, def.maxAutonomy);
  }
}
