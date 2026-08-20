import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, neg } from "./money.ts";

/**
 * Subcontractor compliance engine — the control that decides whether a
 * subcontractor's bill may be posted and whether its money may leave.
 *
 * Two halves, deliberately separated:
 *
 *   PURE (evaluate*)  the whole decision, expressed as functions of policy +
 *                     evidence + a date. No I/O, so the control is unit-tested
 *                     exhaustively rather than exercised through a pay run.
 *   IMPURE (load*, record*)  the loaders that fetch policy and evidence, and
 *                     the writer that freezes each decision into
 *                     compliance_release_checks.
 *
 * Three rules the rest of the module depends on:
 *
 *   1. FAIL CLOSED. Anything the engine cannot evaluate — a coverage limit in a
 *      currency it cannot compare, evidence it cannot verify — is a failure, not
 *      a pass. A control that guesses is not a control.
 *   2. Compliance is DERIVED, never stored. `compliance_records.status` is a
 *      lifecycle (was it accepted?), not an answer to "is this vendor covered
 *      today?". That answer is recomputed from the dates on every read, so no
 *      nightly job can silently become the source of truth.
 *   3. Every decision is SNAPSHOTTED. Tightening a policy tomorrow must not
 *      reinterpret a release granted today, so the evaluation that permitted a
 *      payment is written out in full at the moment it happens.
 */

export class ComplianceError extends Error {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RequirementCategory = "insurance" | "tax_form" | "licence" | "bond" | "safety" | "other";
export type RequirementEnforcement = "advisory" | "warn" | "block_payment" | "block_bill";
export type LienWaiverEnforcement = "none" | "warn" | "block";
export type LienWaiverType =
  | "conditional_progress"
  | "unconditional_progress"
  | "conditional_final"
  | "unconditional_final";

/**
 * Why a requirement is not satisfied. Machine-readable so the UI, the pay-run
 * blockers and the frozen snapshot all name the same failure.
 */
export type ComplianceReason =
  | "no_evidence"
  | "rejected"
  | "awaiting_verification"
  | "not_yet_effective"
  | "expired"
  | "coverage_below_minimum"
  | "aggregate_below_minimum"
  | "coverage_currency_mismatch"
  | "coverage_amount_missing"
  | "missing_additional_insured"
  | "missing_waiver_of_subrogation"
  | "missing_primary_noncontributory";

/**
 * `compliant`  — covered today.
 * `expiring`   — covered today, inside the warning window. NOT a failure.
 * `waived`     — failing, but an approved unexpired exception suppresses it.
 * everything else is a failure.
 */
export type ComplianceState =
  | "compliant"
  | "expiring"
  | "waived"
  | "missing"
  | "expired"
  | "insufficient"
  | "awaiting_verification"
  | "rejected";

const FAILING_STATES: ReadonlySet<ComplianceState> = new Set<ComplianceState>([
  "missing",
  "expired",
  "insufficient",
  "awaiting_verification",
  "rejected",
]);

export type RequirementPolicy = {
  id: string;
  code: string;
  name: string;
  category: RequirementCategory;
  /** null = applies to every classified vendor. */
  classId: string | null;
  requiresExpiry: boolean;
  minCoverageAmount: string | null;
  minAggregateAmount: string | null;
  coverageCurrency: string | null;
  requiresAdditionalInsured: boolean;
  requiresWaiverOfSubrogation: boolean;
  requiresPrimaryNoncontributory: boolean;
  enforcement: RequirementEnforcement;
  graceDays: number;
  expiryWarningDays: number;
  requiresVerification: boolean;
};

export type EvidenceRecord = {
  id: string;
  requirementId: string;
  /** Project-specific certificate (wrap/OCIP policy); null = vendor-wide. */
  projectId: string | null;
  status: "pending_review" | "active" | "rejected" | "superseded";
  effectiveFrom: string;
  expiresOn: string | null;
  coverageAmount: string | null;
  aggregateAmount: string | null;
  coverageCurrency: string | null;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
  primaryNoncontributory: boolean;
  verifiedAt: string | null;
};

export type WaiverRecord = {
  id: string;
  requirementId: string;
  projectId: string | null;
  effectiveFrom: string;
  expiresOn: string;
  revokedAt: string | null;
};

export interface RequirementFinding {
  requirementId: string;
  code: string;
  name: string;
  category: RequirementCategory;
  enforcement: RequirementEnforcement;
  state: ComplianceState;
  /** The evidence row the state came from; null when nothing is on file. */
  recordId: string | null;
  expiresOn: string | null;
  /** Negative once expired. Null when the requirement carries no expiry. */
  daysToExpiry: number | null;
  waiverId: string | null;
  reasons: ComplianceReason[];
  blocksPayment: boolean;
  blocksBill: boolean;
}

export interface VendorComplianceStatus {
  partyId: string;
  /** null when the vendor carries no compliance class (not tracked). */
  classId: string | null;
  tracked: boolean;
  asOf: string;
  projectId: string | null;
  findings: RequirementFinding[];
  /** Worst state across findings, for a single badge. */
  overall: ComplianceState;
  blocksPayment: boolean;
  blocksBill: boolean;
  /** Failing findings that carry a blocking enforcement, for messages. */
  blockingCodes: string[];
}

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

/** Whole days from `from` to `to` (both ISO yyyy-mm-dd), calendar-exact in UTC. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new ComplianceError(`invalid date in range ${from}..${to}`);
  return Math.round((b - a) / 86_400_000);
}

/** ISO date `days` after `from`. */
export function addDays(from: string, days: number): string {
  const t = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(t)) throw new ComplianceError(`invalid date ${from}`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The substantive checks on one certificate: limits and endorsements. Kept
 * separate from the date/lifecycle logic because these are the ones an org
 * configures per policy, and they are the ones that fail closed — an
 * incomparable currency or an absent limit is a failure, never a pass.
 */
function evidenceShortfalls(policy: RequirementPolicy, record: EvidenceRecord): ComplianceReason[] {
  const reasons: ComplianceReason[] = [];
  const needsAmount = policy.minCoverageAmount !== null || policy.minAggregateAmount !== null;
  if (needsAmount) {
    // A limit is a money amount: comparing across currencies without an FX
    // policy would silently approve or reject coverage. Refuse instead.
    if (policy.coverageCurrency && record.coverageCurrency !== policy.coverageCurrency) {
      reasons.push("coverage_currency_mismatch");
    }
  }
  if (policy.minCoverageAmount !== null) {
    if (record.coverageAmount === null) reasons.push("coverage_amount_missing");
    else if (cmp(record.coverageAmount, policy.minCoverageAmount) < 0) reasons.push("coverage_below_minimum");
  }
  if (policy.minAggregateAmount !== null) {
    if (record.aggregateAmount === null) reasons.push("coverage_amount_missing");
    else if (cmp(record.aggregateAmount, policy.minAggregateAmount) < 0) reasons.push("aggregate_below_minimum");
  }
  if (policy.requiresAdditionalInsured && !record.additionalInsured) reasons.push("missing_additional_insured");
  if (policy.requiresWaiverOfSubrogation && !record.waiverOfSubrogation) {
    reasons.push("missing_waiver_of_subrogation");
  }
  if (policy.requiresPrimaryNoncontributory && !record.primaryNoncontributory) {
    reasons.push("missing_primary_noncontributory");
  }
  return [...new Set(reasons)];
}

/** Ranking used to pick which of several imperfect answers to report. */
const STATE_RANK: Record<ComplianceState, number> = {
  compliant: 0,
  expiring: 1,
  waived: 2,
  awaiting_verification: 3,
  insufficient: 4,
  expired: 5,
  rejected: 6,
  missing: 7,
};

interface Candidate {
  state: ComplianceState;
  reasons: ComplianceReason[];
  record: EvidenceRecord | null;
}

/** Evaluate one certificate against one policy on one date. */
function evaluateEvidence(
  policy: RequirementPolicy,
  record: EvidenceRecord,
  asOf: string,
): Candidate {
  if (record.status === "rejected") return { state: "rejected", reasons: ["rejected"], record };
  if (record.status === "superseded") {
    // Superseded evidence never answers for itself; its replacement does.
    return { state: "missing", reasons: ["no_evidence"], record: null };
  }
  const shortfalls = evidenceShortfalls(policy, record);
  if (record.status === "pending_review" || (policy.requiresVerification && !record.verifiedAt)) {
    return { state: "awaiting_verification", reasons: ["awaiting_verification", ...shortfalls], record };
  }
  if (daysBetween(record.effectiveFrom, asOf) < 0) {
    return { state: "insufficient", reasons: ["not_yet_effective", ...shortfalls], record };
  }
  if (policy.requiresExpiry && record.expiresOn === null) {
    // The policy says this evidence expires; a certificate without an expiry
    // cannot be shown to be in force.
    return { state: "insufficient", reasons: ["expired", ...shortfalls], record };
  }
  if (record.expiresOn !== null) {
    const daysLeft = daysBetween(asOf, record.expiresOn);
    if (daysLeft + policy.graceDays < 0) {
      return { state: "expired", reasons: ["expired", ...shortfalls], record };
    }
    if (shortfalls.length > 0) return { state: "insufficient", reasons: shortfalls, record };
    if (daysLeft <= policy.expiryWarningDays) return { state: "expiring", reasons: [], record };
    return { state: "compliant", reasons: [], record };
  }
  if (shortfalls.length > 0) return { state: "insufficient", reasons: shortfalls, record };
  return { state: "compliant", reasons: [], record };
}

/**
 * Evaluate one policy for one vendor: pick the best answer across every
 * certificate on file, then let an approved exception suppress a failure.
 *
 * "Best" is the point: a vendor that uploaded next year's COI early plus a
 * lapsed one is covered, and the finding reports the row that covers them.
 */
export function evaluateRequirement(args: {
  policy: RequirementPolicy;
  records: readonly EvidenceRecord[];
  waivers: readonly WaiverRecord[];
  asOf: string;
  /** Restricts project-specific evidence and exceptions to one project. */
  projectId?: string | null;
}): RequirementFinding {
  const { policy, asOf } = args;
  const projectId = args.projectId ?? null;
  const inScope = <T extends { projectId: string | null }>(row: T) =>
    row.projectId === null || (projectId !== null && row.projectId === projectId);

  const candidates = args.records
    .filter((r) => r.requirementId === policy.id && inScope(r))
    .map((r) => evaluateEvidence(policy, r, asOf));

  let best: Candidate = candidates.length > 0
    ? candidates.reduce((a, b) => (STATE_RANK[b.state] < STATE_RANK[a.state] ? b : a))
    : { state: "missing", reasons: ["no_evidence"], record: null };

  // Two certificates ranked equal: prefer the one that covers longest, so the
  // reported expiry is the one the vendor actually relies on.
  if (candidates.length > 1) {
    const tied = candidates.filter((c) => c.state === best.state && c.record);
    if (tied.length > 1) {
      best = tied.reduce((a, b) => {
        const ae = a.record?.expiresOn ?? "9999-12-31";
        const be = b.record?.expiresOn ?? "9999-12-31";
        return be > ae ? b : a;
      });
    }
  }

  const waiver = args.waivers.find(
    (w) =>
      w.requirementId === policy.id &&
      inScope(w) &&
      w.revokedAt === null &&
      daysBetween(w.effectiveFrom, asOf) >= 0 &&
      daysBetween(asOf, w.expiresOn) >= 0,
  );

  const failing = FAILING_STATES.has(best.state);
  const state: ComplianceState = failing && waiver ? "waived" : best.state;
  const enforced = FAILING_STATES.has(state);
  const blocksBill = enforced && policy.enforcement === "block_bill";
  // block_bill is strictly stronger than block_payment: evidence that stops a
  // bill from being recorded certainly stops its cash from leaving.
  const blocksPayment = enforced && (policy.enforcement === "block_payment" || policy.enforcement === "block_bill");

  return {
    requirementId: policy.id,
    code: policy.code,
    name: policy.name,
    category: policy.category,
    enforcement: policy.enforcement,
    state,
    recordId: best.record?.id ?? null,
    expiresOn: best.record?.expiresOn ?? null,
    daysToExpiry: best.record?.expiresOn ? daysBetween(asOf, best.record.expiresOn) : null,
    waiverId: waiver?.id ?? null,
    reasons: best.reasons,
    blocksPayment,
    blocksBill,
  };
}

/**
 * Roll a vendor's policies up into one status. An unclassified vendor is not
 * tracked and never blocks: compliance is something an org opts a counterparty
 * into, not a trap every new supplier falls into.
 */
export function evaluateVendorCompliance(args: {
  partyId: string;
  classId: string | null;
  policies: readonly RequirementPolicy[];
  records: readonly EvidenceRecord[];
  waivers: readonly WaiverRecord[];
  asOf: string;
  projectId?: string | null;
}): VendorComplianceStatus {
  const projectId = args.projectId ?? null;
  if (!args.classId) {
    return {
      partyId: args.partyId,
      classId: null,
      tracked: false,
      asOf: args.asOf,
      projectId,
      findings: [],
      overall: "compliant",
      blocksPayment: false,
      blocksBill: false,
      blockingCodes: [],
    };
  }
  const applicable = args.policies.filter((p) => p.classId === null || p.classId === args.classId);
  const findings = applicable.map((policy) =>
    evaluateRequirement({ policy, records: args.records, waivers: args.waivers, asOf: args.asOf, projectId }),
  );
  const overall = findings.reduce<ComplianceState>(
    (worst, f) => (STATE_RANK[f.state] > STATE_RANK[worst] ? f.state : worst),
    "compliant",
  );
  return {
    partyId: args.partyId,
    classId: args.classId,
    tracked: true,
    asOf: args.asOf,
    projectId,
    findings,
    overall,
    blocksPayment: findings.some((f) => f.blocksPayment),
    blocksBill: findings.some((f) => f.blocksBill),
    blockingCodes: findings.filter((f) => f.blocksPayment || f.blocksBill).map((f) => f.code),
  };
}

// ---------------------------------------------------------------------------
// Lien-waiver coverage
// ---------------------------------------------------------------------------

export type LienWaiverEvidence = {
  id: string;
  waiverNumber: string;
  status: "draft" | "requested" | "received" | "signed" | "rejected" | "void";
  direction: "received" | "issued";
  projectId: string;
  throughDate: string;
  amount: string;
  currency: string;
  billDocumentId: string | null;
};

export interface LienWaiverCoverage {
  enforcement: LienWaiverEnforcement;
  /** Whether a waiver is needed at all for this bill. */
  required: boolean;
  covered: boolean;
  /** The waiver relied upon, when covered. */
  waiverId: string | null;
  waiverNumber: string | null;
  /** Furthest signed through-date on file for the project. */
  coveredThrough: string | null;
  /** Amount still unreleased when a waiver is short. */
  shortfall: string | null;
  reason: "not_required" | "covered" | "no_signed_waiver" | "through_date_short" | "amount_short" | "currency_mismatch" | null;
  blocksPayment: boolean;
}

/**
 * Does a signed waiver release this bill?
 *
 * A waiver explicitly linked to the bill governs it — that is the pairing the
 * signatory intended. Otherwise the newest signed waiver for the same project
 * counts, provided it reaches the bill's date and its amount at least matches
 * the bill. Currencies must agree: a release stated in another currency is not
 * a release this control can measure.
 */
export function evaluateLienWaiverCoverage(args: {
  enforcement: LienWaiverEnforcement;
  projectId: string | null;
  billDocumentId: string;
  billDate: string;
  billAmount: string;
  billCurrency: string;
  waivers: readonly LienWaiverEvidence[];
}): LienWaiverCoverage {
  const base = {
    enforcement: args.enforcement,
    waiverId: null,
    waiverNumber: null,
    coveredThrough: null,
    shortfall: null,
    blocksPayment: false,
  };
  // No project means no lien to waive; a waiver is a claim against improved
  // real property, not against a vendor in general.
  if (args.enforcement === "none" || !args.projectId) {
    return { ...base, required: false, covered: true, reason: "not_required" };
  }

  const signed = args.waivers.filter(
    (w) => w.direction === "received" && w.status === "signed" && w.projectId === args.projectId,
  );
  const linked = signed.filter((w) => w.billDocumentId === args.billDocumentId);
  const pool = linked.length > 0 ? linked : signed;
  const coveredThrough = pool.reduce<string | null>(
    (max, w) => (max === null || w.throughDate > max ? w.throughDate : max),
    null,
  );

  const fail = (reason: LienWaiverCoverage["reason"], shortfall: string | null = null): LienWaiverCoverage => ({
    ...base,
    required: true,
    covered: false,
    coveredThrough,
    shortfall,
    reason,
    blocksPayment: args.enforcement === "block",
  });

  if (pool.length === 0) return fail("no_signed_waiver");

  const reaching = pool.filter((w) => w.throughDate >= args.billDate);
  if (reaching.length === 0) return fail("through_date_short");
  if (reaching.some((w) => w.currency !== args.billCurrency)) {
    const sameCurrency = reaching.filter((w) => w.currency === args.billCurrency);
    if (sameCurrency.length === 0) return fail("currency_mismatch");
  }
  const usable = reaching.filter((w) => w.currency === args.billCurrency);
  const sufficient = usable.filter((w) => cmp(w.amount, args.billAmount) >= 0);
  if (sufficient.length === 0) {
    const bestAmount = usable.reduce<string>((max, w) => (cmp(w.amount, max) > 0 ? w.amount : max), "0");
    return fail("amount_short", add(args.billAmount, neg(bestAmount)));
  }
  // Prefer the tightest sufficient release, so the reported waiver is the one a
  // reviewer would point at rather than an unrelated larger one.
  const chosen = sufficient.reduce((a, b) => (cmp(b.amount, a.amount) < 0 ? b : a));
  return {
    ...base,
    required: true,
    covered: true,
    waiverId: chosen.id,
    waiverNumber: chosen.waiverNumber,
    coveredThrough,
    reason: "covered",
  };
}

// ---------------------------------------------------------------------------
// Feature gate (engine side)
// ---------------------------------------------------------------------------

/**
 * Is subcontractor compliance on for this org? Mirrors web/lib/features.ts
 * (default OFF, no parent gate) so engine-side enforcement cannot be bypassed
 * by calling a service directly instead of going through a page.
 */
export async function complianceFeatureEnabled(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<boolean> {
  const r = (await runner.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'subcontractorCompliance')::boolean, false) as enabled
      from orgs where id = ${orgId}
  `));
  return Boolean(r.rows[0]?.enabled);
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function loadRequirementPolicies(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<RequirementPolicy[]> {
  const r = (await runner.execute<RequirementPolicy>(sql`
    select id, code, name, category, class_id as "classId",
           requires_expiry as "requiresExpiry",
           min_coverage_amount as "minCoverageAmount",
           min_aggregate_amount as "minAggregateAmount",
           coverage_currency as "coverageCurrency",
           requires_additional_insured as "requiresAdditionalInsured",
           requires_waiver_of_subrogation as "requiresWaiverOfSubrogation",
           requires_primary_noncontributory as "requiresPrimaryNoncontributory",
           enforcement, grace_days as "graceDays",
           expiry_warning_days as "expiryWarningDays",
           requires_verification as "requiresVerification"
      from compliance_requirements
     where org_id = ${orgId} and is_active
     order by category, code
  `));
  return r.rows;
}

export interface VendorComplianceInputs {
  classId: string | null;
  lienWaiverEnforcement: LienWaiverEnforcement;
  records: EvidenceRecord[];
  waivers: WaiverRecord[];
  lienWaivers: LienWaiverEvidence[];
}

/** Everything needed to evaluate one vendor, in three round trips. */
export async function loadVendorComplianceInputs(
  orgId: string,
  partyId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<VendorComplianceInputs> {
  const [role, records, waivers, lienWaivers] = (await Promise.all([
    runner.execute<{ classId: string | null; lienWaiverEnforcement: LienWaiverEnforcement }>(sql`
      select vr.compliance_class_id as "classId",
             coalesce(cc.lien_waiver_enforcement, 'none') as "lienWaiverEnforcement"
        from vendor_roles vr
        left join compliance_classes cc
               on cc.id = vr.compliance_class_id and cc.org_id = vr.org_id and cc.is_active
       where vr.org_id = ${orgId} and vr.party_id = ${partyId}`),
    runner.execute<EvidenceRecord>(sql`
      select id, requirement_id as "requirementId", project_id as "projectId", status,
             effective_from as "effectiveFrom", expires_on as "expiresOn",
             coverage_amount as "coverageAmount", aggregate_amount as "aggregateAmount",
             coverage_currency as "coverageCurrency",
             additional_insured as "additionalInsured",
             waiver_of_subrogation as "waiverOfSubrogation",
             primary_noncontributory as "primaryNoncontributory",
             verified_at as "verifiedAt"
        from compliance_records
       where org_id = ${orgId} and party_id = ${partyId} and status <> 'superseded'`),
    runner.execute<WaiverRecord>(sql`
      select id, requirement_id as "requirementId", project_id as "projectId",
             effective_from as "effectiveFrom", expires_on as "expiresOn",
             revoked_at as "revokedAt"
        from compliance_waivers
       where org_id = ${orgId} and party_id = ${partyId} and revoked_at is null`),
    runner.execute<LienWaiverEvidence>(sql`
      select id, waiver_number as "waiverNumber", status, direction,
             project_id as "projectId", through_date as "throughDate",
             amount, currency, bill_document_id as "billDocumentId"
        from lien_waivers
       where org_id = ${orgId} and party_id = ${partyId} and direction = 'received'
         and status = 'signed'`),
  ]));
  return {
    classId: role.rows[0]?.classId ?? null,
    lienWaiverEnforcement: role.rows[0]?.lienWaiverEnforcement ?? "none",
    records: records.rows,
    waivers: waivers.rows,
    lienWaivers: lienWaivers.rows,
  };
}

/** One vendor's status, policy + evidence loaded and evaluated. */
export async function vendorComplianceStatus(args: {
  orgId: string;
  partyId: string;
  asOf?: string;
  projectId?: string | null;
  runner?: Pick<typeof db, "execute">;
}): Promise<VendorComplianceStatus> {
  const runner = args.runner ?? db;
  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
  const [policies, inputs] = await Promise.all([
    loadRequirementPolicies(args.orgId, runner),
    loadVendorComplianceInputs(args.orgId, args.partyId, runner),
  ]);
  return evaluateVendorCompliance({
    partyId: args.partyId,
    classId: inputs.classId,
    policies,
    records: inputs.records,
    waivers: inputs.waivers,
    asOf,
    projectId: args.projectId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Bill-level release decision
// ---------------------------------------------------------------------------

export interface BillReleaseInput {
  documentId: string;
  documentNumber: string;
  partyId: string;
  vendorName: string;
  projectId: string | null;
  documentDate: string;
  amount: string;
  currency: string;
}

export interface BillReleaseDecision {
  documentId: string;
  documentNumber: string;
  partyId: string;
  vendorName: string;
  decision: "cleared" | "warned" | "blocked";
  /** Human-facing summary lines, already ordered worst-first. */
  reasons: string[];
  compliance: VendorComplianceStatus;
  lienWaiver: LienWaiverCoverage;
}

/** Wording used by pay-run blockers, the AP planner, and the frozen snapshot. */
function describeFinding(f: RequirementFinding): string {
  const detail = f.reasons.length > 0 ? ` (${f.reasons.join(", ")})` : "";
  return `${f.name}: ${f.state.replace(/_/g, " ")}${detail}`;
}

function describeLienWaiver(c: LienWaiverCoverage): string {
  switch (c.reason) {
    case "no_signed_waiver":
      return "lien waiver: none signed for this project";
    case "through_date_short":
      return `lien waiver: signed only through ${c.coveredThrough ?? "an earlier date"}`;
    case "amount_short":
      return `lien waiver: ${c.shortfall ?? "part of the bill"} unreleased`;
    case "currency_mismatch":
      return "lien waiver: signed in a different currency";
    default:
      return "lien waiver: outstanding";
  }
}

/**
 * The single decision function every payment path routes through: pay-run
 * creation, run readiness, and posting. One implementation means the answer
 * cannot differ between the screen that shows a blocker and the code that
 * enforces it.
 */
export function evaluateBillRelease(args: {
  bill: BillReleaseInput;
  policies: readonly RequirementPolicy[];
  inputs: VendorComplianceInputs;
  asOf: string;
}): BillReleaseDecision {
  const compliance = evaluateVendorCompliance({
    partyId: args.bill.partyId,
    classId: args.inputs.classId,
    policies: args.policies,
    records: args.inputs.records,
    waivers: args.inputs.waivers,
    asOf: args.asOf,
    projectId: args.bill.projectId,
  });
  const lienWaiver = evaluateLienWaiverCoverage({
    enforcement: compliance.tracked ? args.inputs.lienWaiverEnforcement : "none",
    projectId: args.bill.projectId,
    billDocumentId: args.bill.documentId,
    billDate: args.bill.documentDate,
    billAmount: args.bill.amount,
    billCurrency: args.bill.currency,
    waivers: args.inputs.lienWaivers,
  });

  const blocked = compliance.blocksPayment || lienWaiver.blocksPayment;
  const warnings = compliance.findings.filter(
    (f) => FAILING_STATES.has(f.state) && !f.blocksPayment && f.enforcement !== "advisory",
  );
  const blockingFindings = compliance.findings.filter((f) => f.blocksPayment);
  const reasons = [
    ...blockingFindings.map(describeFinding),
    ...(lienWaiver.blocksPayment ? [describeLienWaiver(lienWaiver)] : []),
    ...warnings.map(describeFinding),
    ...(!lienWaiver.covered && !lienWaiver.blocksPayment && lienWaiver.required
      ? [describeLienWaiver(lienWaiver)]
      : []),
  ];
  return {
    documentId: args.bill.documentId,
    documentNumber: args.bill.documentNumber,
    partyId: args.bill.partyId,
    vendorName: args.bill.vendorName,
    decision: blocked ? "blocked" : reasons.length > 0 ? "warned" : "cleared",
    reasons,
    compliance,
    lienWaiver,
  };
}

/**
 * Evaluate a set of bills for release. Policies load once; per-vendor evidence
 * loads once per distinct vendor, not once per bill.
 */
export async function evaluateBillsForRelease(args: {
  orgId: string;
  bills: readonly BillReleaseInput[];
  asOf?: string;
  runner?: Pick<typeof db, "execute">;
}): Promise<BillReleaseDecision[]> {
  if (args.bills.length === 0) return [];
  const runner = args.runner ?? db;
  if (!(await complianceFeatureEnabled(args.orgId, runner))) {
    // Feature off: every bill clears, and we say so explicitly rather than
    // returning an empty list a caller could mistake for "nothing checked".
    return args.bills.map((bill) => ({
      documentId: bill.documentId,
      documentNumber: bill.documentNumber,
      partyId: bill.partyId,
      vendorName: bill.vendorName,
      decision: "cleared" as const,
      reasons: [],
      compliance: {
        partyId: bill.partyId,
        classId: null,
        tracked: false,
        asOf: args.asOf ?? new Date().toISOString().slice(0, 10),
        projectId: bill.projectId,
        findings: [],
        overall: "compliant" as const,
        blocksPayment: false,
        blocksBill: false,
        blockingCodes: [],
      },
      lienWaiver: {
        enforcement: "none" as const,
        required: false,
        covered: true,
        waiverId: null,
        waiverNumber: null,
        coveredThrough: null,
        shortfall: null,
        reason: "not_required" as const,
        blocksPayment: false,
      },
    }));
  }
  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
  const policies = await loadRequirementPolicies(args.orgId, runner);
  const partyIds = [...new Set(args.bills.map((b) => b.partyId))];
  const inputs = new Map<string, VendorComplianceInputs>();
  for (const partyId of partyIds) {
    inputs.set(partyId, await loadVendorComplianceInputs(args.orgId, partyId, runner));
  }
  return args.bills.map((bill) =>
    evaluateBillRelease({ bill, policies, inputs: inputs.get(bill.partyId)!, asOf }),
  );
}

// ---------------------------------------------------------------------------
// Decision evidence
// ---------------------------------------------------------------------------

/**
 * Freeze one release decision. This is the auditor's record that the control
 * ran: the policy as it stood, the evidence as it stood, and the outcome.
 */
export async function recordReleaseCheck(args: {
  orgId: string;
  partyId: string;
  documentId?: string | null;
  paymentRunId?: string | null;
  paymentInstructionId?: string | null;
  stage: "run_created" | "readiness" | "run_posted" | "manual";
  decision: "cleared" | "warned" | "blocked" | "overridden";
  snapshot: unknown;
  overrideReason?: string | null;
  overriddenBy?: string | null;
  checkedBy?: string | null;
  runner?: Pick<typeof db, "execute">;
}): Promise<void> {
  const runner = args.runner ?? db;
  if (args.decision === "overridden" && !(args.overrideReason && args.overriddenBy)) {
    throw new ComplianceError("an override must record who accepted the risk and why");
  }
  await runner.execute(sql`
    insert into compliance_release_checks
      (org_id, party_id, document_id, payment_run_id, payment_instruction_id,
       stage, decision, snapshot, override_reason, overridden_by, checked_by)
    values (${args.orgId}, ${args.partyId}, ${args.documentId ?? null}, ${args.paymentRunId ?? null},
            ${args.paymentInstructionId ?? null}, ${args.stage}, ${args.decision},
            ${JSON.stringify(args.snapshot ?? {})}::jsonb,
            ${args.overrideReason ?? null}, ${args.overriddenBy ?? null}, ${args.checkedBy ?? null})
  `);
}

/**
 * Enforcement for bill POSTING (`block_bill` requirements). Called from the
 * posting kernel so a blocked subcontractor bill cannot be recorded at all,
 * whatever route created it.
 */
export async function assertBillPostingAllowed(args: {
  orgId: string;
  partyId: string;
  projectId: string | null;
  documentNumber: string;
  asOf?: string;
  runner?: Pick<typeof db, "execute">;
}): Promise<void> {
  const runner = args.runner ?? db;
  if (!(await complianceFeatureEnabled(args.orgId, runner))) return;
  const status = await vendorComplianceStatus({
    orgId: args.orgId,
    partyId: args.partyId,
    projectId: args.projectId,
    asOf: args.asOf,
    runner,
  });
  if (!status.blocksBill) return;
  const failing = status.findings.filter((f) => f.blocksBill).map(describeFinding);
  throw new ComplianceError(
    `${args.documentNumber} cannot be posted — subcontractor compliance blocks it: ${failing.join("; ")}`,
  );
}
