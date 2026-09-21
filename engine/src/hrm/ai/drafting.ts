import { sql } from "drizzle-orm";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { loadOwnEmploymentIds } from "../authorization.ts";
import { actorPartyOf } from "../self-service/actor.ts";
import { AiRailsError, aiSubjectRefused } from "./errors.ts";
import { logDecision } from "./governance.ts";
import { loadAiRailsSettings } from "./settings.ts";

/**
 * HRM AI rails (HR-21) evidence-grounded drafting. The deterministic
 * collector assembles ONLY the sources the actor may read — an
 * unreadable source refuses the whole draft with the remedy, never a
 * redacted half-draft — and the service renders a structured evidence
 * outline the human edits and submits through the existing form.
 *
 * A draft NEVER auto-submits: this service holds no write path except
 * the ai_decisions row (proven by the no-write-path test, whose double
 * throws on any other write). The bias check flags org-declared terms
 * (Setup-owned, never a built-in list) and returns flags with the draft.
 */

export const DRAFT_KINDS = [
  "job_description",
  "review_manager",
  "review_self",
  "onboarding_plan",
  "offer_letter_clauses",
] as const;

export type DraftKind = (typeof DRAFT_KINDS)[number];

export interface DraftSource {
  kind: string;
  id: string;
  excerpt: string;
}

export interface BiasFlag {
  term: string;
  excerpt: string;
}

export interface DraftResult {
  kind: DraftKind;
  subjectId: string;
  text: string;
  sources: DraftSource[];
  biasFlags: BiasFlag[];
  /** Ledger row for the shown draft — PATCH /api/ai/drafts marks the outcome. */
  decisionId: string;
}

/**
 * Flag protected-characteristic language from the org's own term list.
 * Whole-word, case-insensitive; each hit carries its excerpt. An empty
 * org list flags nothing — there is deliberately no built-in list, so
 * no jurisdiction's vocabulary leaks into another org's drafts.
 */
export function flagBiasTerms(text: string, terms: readonly string[]): BiasFlag[] {
  const flags: BiasFlag[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escaped}\\b`, "i").exec(text);
    if (match) {
      const start = Math.max(0, match.index - 40);
      flags.push({
        term,
        excerpt: text.slice(start, match.index + match[0].length + 40).trim(),
      });
    }
  }
  return flags;
}

async function assertDraftFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, "hrmDrafting"))) {
    throw new AiRailsError(
      "ai_feature_off",
      "drafting is unavailable while hrmDrafting is off — enable it under Company Settings → Features",
    );
  }
}

async function requirePerm(
  exec: SqlExecutor, orgId: string, actorId: string, perm: string, remedy: string,
): Promise<void> {
  if (await actorHasPermission(exec, orgId, actorId, perm)) return;
  throw aiSubjectRefused(`drafting needs ${perm}`, remedy);
}

function excerptOf(row: Record<string, unknown>, fields: readonly string[], max = 240): string {
  const bits = fields
    .map((f) => {
      const v = row[f];
      return v === null || v === undefined || v === "" ? null : `${f}: ${String(v)}`;
    })
    .filter((b): b is string => b !== null);
  const text = bits.join(" · ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function collectJobDescription(
  exec: SqlExecutor, orgId: string, actorId: string, requisitionId: string,
): Promise<DraftSource[]> {
  await requirePerm(exec, orgId, actorId, "hrm.recruiting.read",
    "ask a recruiter or hiring manager to draft this description");
  const rows = (await exec.execute<Record<string, unknown>>(sql`
    select r.id::text as id, r.title, r.employment_kind as "employmentKind",
           r.compensation_min::text as "compensationMin",
           r.compensation_max::text as "compensationMax",
           r.compensation_currency as "compensationCurrency",
           r.compensation_basis as "compensationBasis",
           r.description, r.position_id::text as "positionId"
      from hrm_requisitions r
     where r.org_id = ${orgId}::uuid and r.id = ${requisitionId}::uuid`)).rows;
  const req = rows[0];
  if (!req) {
    throw new AiRailsError(
      "ai_subject_missing",
      `requisition ${requisitionId} matched no row — it is missing or outside this organization; reload and retry`,
    );
  }
  const sources: DraftSource[] = [{
    kind: "hrm_requisition",
    id: String(req.id),
    excerpt: excerptOf(req, ["title", "employmentKind", "compensationMin", "compensationMax", "compensationCurrency", "compensationBasis", "description"]),
  }];
  if (req.positionId) {
    const pos = (await exec.execute<Record<string, unknown>>(sql`
      select v.title, v.job_grade as "jobGrade"
        from position_versions v
       where v.org_id = ${orgId}::uuid and v.position_id = ${String(req.positionId)}::uuid
         and v.recorded_until is null
       order by v.version_no desc
       limit 1`)).rows[0];
    if (pos) {
      sources.push({
        kind: "position_version",
        id: String(req.positionId),
        excerpt: excerptOf(pos, ["title", "jobGrade"]),
      });
    }
  }
  return sources;
}

type ReviewRow = {
  id: string;
  cycleId: string;
  employmentId: string;
  subjectPartyId: string;
  reviewerPartyId: string;
  kind: string;
  status: string;
}

async function loadReview(exec: SqlExecutor, orgId: string, reviewId: string): Promise<ReviewRow> {
  const rows = (await exec.execute<ReviewRow>(sql`
    select id::text as id, cycle_id::text as "cycleId",
           employment_id::text as "employmentId",
           subject_party_id::text as "subjectPartyId",
           reviewer_party_id::text as "reviewerPartyId", kind, status
      from hrm_reviews
     where org_id = ${orgId}::uuid and id = ${reviewId}::uuid`)).rows;
  const review = rows[0];
  if (!review) {
    throw new AiRailsError(
      "ai_subject_missing",
      `review ${reviewId} matched no row — it is missing or outside this organization; reload and retry`,
    );
  }
  return review;
}

async function collectReview(
  exec: SqlExecutor, orgId: string, actorId: string, reviewId: string, self: boolean,
): Promise<DraftSource[]> {
  const partyId = await actorPartyOf(exec, orgId, actorId);
  const review = await loadReview(exec, orgId, reviewId);
  if (self) {
    // Self drafts read only the author's own review through their own grant.
    if (review.subjectPartyId !== partyId || review.kind !== "self") {
      throw aiSubjectRefused(
        "this review is not your self review",
        "open your own self review from Me, or ask the review owner for access",
      );
    }
    const own = await loadOwnEmploymentIds(exec, orgId, actorId);
    if (!own.includes(review.employmentId)) {
      throw aiSubjectRefused(
        "this review's employment is outside your self-service scope",
        "open your own self review from Me",
      );
    }
  } else {
    await requirePerm(exec, orgId, actorId, "hrm.performance.manage",
      "only the manager (or HR) drafts this review — ask them");
    if (review.kind !== "manager") {
      throw new AiRailsError(
        "ai_wrong_kind",
        `review ${reviewId} is a ${review.kind} review, not a manager review — draft it from its own form`,
      );
    }
    if (review.reviewerPartyId !== partyId
      && !(await actorHasPermission(exec, orgId, actorId, "hrm.retention.read"))) {
      throw aiSubjectRefused(
        "you are not this review's manager",
        "ask the assigned manager or HR to draft this review",
      );
    }
  }
  const sources: DraftSource[] = [{
    kind: "hrm_review",
    id: review.id,
    excerpt: `cycle review (${review.kind}, status ${review.status})`,
  }];
  const cycle = (await exec.execute<Record<string, unknown>>(sql`
    select id::text as id, name, period_start_on::text as "periodStart",
           period_end_on::text as "periodEnd"
      from hrm_review_cycles
     where org_id = ${orgId}::uuid and id = ${review.cycleId}::uuid`)).rows[0];
  if (cycle) {
    sources.push({ kind: "hrm_review_cycle", id: String(cycle.id), excerpt: excerptOf(cycle, ["name", "periodStart", "periodEnd"]) });
  }
  const goals = (await exec.execute<Record<string, unknown>>(sql`
    select id::text as id, title, status, progress_percent as "progressPercent"
      from hrm_goals
     where org_id = ${orgId}::uuid and employment_id = ${review.employmentId}::uuid
       and (cycle_id = ${review.cycleId}::uuid or cycle_id is null)
     order by id
     limit 20`)).rows;
  for (const g of goals) {
    sources.push({ kind: "hrm_goal", id: String(g.id), excerpt: excerptOf(g, ["title", "status", "progressPercent"]) });
  }
  const priors = (await exec.execute<Record<string, unknown>>(sql`
    select r.id::text as id, r.calibrated_rating::text as "calibratedRating",
           r.overall_rating::text as "overallRating", c.name as cycle
      from hrm_reviews r
      join hrm_review_cycles c on c.org_id = r.org_id and c.id = r.cycle_id
     where r.org_id = ${orgId}::uuid and r.employment_id = ${review.employmentId}::uuid
       and r.id <> ${review.id}::uuid and r.shared_at is not null
       and r.calibrated_rating is not null
     order by c.period_end_on desc
     limit 3`)).rows;
  for (const p of priors) {
    sources.push({ kind: "hrm_review", id: String(p.id), excerpt: excerptOf(p, ["cycle", "overallRating", "calibratedRating"]) });
  }
  return sources;
}

async function collectOnboardingPlan(
  exec: SqlExecutor, orgId: string, actorId: string, templateId: string,
): Promise<DraftSource[]> {
  await requirePerm(exec, orgId, actorId, "hrm.process.read",
    "ask an HR administrator to draft this onboarding plan");
  const template = (await exec.execute<Record<string, unknown>>(sql`
    select id::text as id, kind, name
      from hrm_process_templates
     where org_id = ${orgId}::uuid and id = ${templateId}::uuid and is_active`)).rows[0];
  if (!template) {
    throw new AiRailsError(
      "ai_subject_missing",
      `process template ${templateId} matched no active row — it is missing, inactive or outside this organization; pick the template from the onboarding form`,
    );
  }
  const sources: DraftSource[] = [{
    kind: "hrm_process_template",
    id: String(template.id),
    excerpt: excerptOf(template, ["kind", "name"]),
  }];
  const steps = (await exec.execute<Record<string, unknown>>(sql`
    select id::text as id, title, position
      from hrm_process_template_steps
     where org_id = ${orgId}::uuid and template_id = ${templateId}::uuid
     order by position
     limit 30`)).rows;
  for (const s of steps) {
    sources.push({ kind: "hrm_process_template_step", id: String(s.id), excerpt: excerptOf(s, ["title", "position"]) });
  }
  // Precedent: the last three completed processes from the same template,
  // so the plan learns from what actually happened.
  const priors = (await exec.execute<Record<string, unknown>>(sql`
    select id::text as id, employment_id::text as "employmentId",
           effective_date::text as "effectiveDate", completed_at::text as "completedAt"
      from hrm_processes
     where org_id = ${orgId}::uuid and template_id = ${templateId}::uuid
       and status = 'completed'
     order by completed_at desc
     limit 3`)).rows;
  for (const p of priors) {
    sources.push({ kind: "hrm_process", id: String(p.id), excerpt: excerptOf(p, ["employmentId", "effectiveDate", "completedAt"]) });
  }
  return sources;
}

async function collectOfferClauses(
  exec: SqlExecutor, orgId: string, actorId: string, offerId: string,
): Promise<DraftSource[]> {
  await requirePerm(exec, orgId, actorId, "hrm.recruiting.manage",
    "only the hiring team drafts offer clauses — ask a recruiter or hiring manager");
  const offer = (await exec.execute<Record<string, unknown>>(sql`
    select id::text as id, job_title as "jobTitle",
           employment_kind as "employmentKind",
           proposed_start_on::text as "proposedStart",
           compensation_amount::text as "compensationAmount",
           compensation_currency as "compensationCurrency",
           compensation_basis as "compensationBasis"
      from hrm_offers
     where org_id = ${orgId}::uuid and id = ${offerId}::uuid`)).rows[0];
  if (!offer) {
    throw new AiRailsError(
      "ai_subject_missing",
      `offer ${offerId} matched no row — it is missing or outside this organization; reload and retry`,
    );
  }
  const sources: DraftSource[] = [{
    kind: "hrm_offer",
    id: String(offer.id),
    excerpt: excerptOf(offer, ["jobTitle", "employmentKind", "proposedStart", "compensationAmount", "compensationCurrency", "compensationBasis"]),
  }];
  const band = (await exec.execute<Record<string, unknown>>(sql`
    select id::text as id, min::text as min, target::text as target,
           max::text as max, currency, basis
      from pay_bands
     where org_id = ${orgId}::uuid
       and currency = ${String(offer.compensationCurrency)}
       and basis = ${String(offer.compensationBasis)}
       and min <= ${String(offer.compensationAmount)}::numeric
       and max >= ${String(offer.compensationAmount)}::numeric
     order by id
     limit 1`)).rows[0];
  if (band) {
    sources.push({ kind: "pay_band", id: String(band.id), excerpt: excerptOf(band, ["min", "target", "max", "currency", "basis"]) });
  }
  return sources;
}

/** Deterministic evidence outline — the human edits and submits the prose. */
function renderOutline(kind: DraftKind, sources: DraftSource[]): string {
  const lines = sources.map((s, i) => `${i + 1}. [${s.kind} ${s.id}] ${s.excerpt}`);
  switch (kind) {
    case "job_description":
      return `Draft from evidence — edit before use.\nRole and terms (from the requisition and position):\n${lines.join("\n")}\nWrite the responsibilities, requirements and offer from the sources above; do not invent benefits or ranges not cited.`;
    case "review_manager":
      return `Manager review draft from evidence — edit before use.\nGoals, cycle scope and prior calibrated ratings:\n${lines.join("\n")}\nAssess each goal against its cited progress; keep every claim attached to a source.`;
    case "review_self":
      return `Self review draft from evidence — edit before use.\nYour goals and prior ratings:\n${lines.join("\n")}\nDescribe your impact per goal, citing the records above.`;
    case "onboarding_plan":
      return `Onboarding plan draft from evidence — edit before use.\nTemplate steps and the last completed precedents:\n${lines.join("\n")}\nSequence the steps with owners and due dates; keep what worked in the precedents.`;
    case "offer_letter_clauses":
      return `Offer clause draft from evidence — edit before use.\nOffer terms and the pay band they sit in:\n${lines.join("\n")}\nState title, start, compensation and basis exactly as cited; HR approves before sending.`;
  }
}

export async function draftFromEvidence(
  exec: SqlExecutor,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly kind: DraftKind;
    readonly subjectId: string;
  },
): Promise<DraftResult> {
  const { orgId, actorId, kind, subjectId } = input;
  if (!orgId || !actorId || !subjectId) {
    throw new AiRailsError("ai_invalid_input", "orgId, actorId and subjectId are required");
  }
  if (!DRAFT_KINDS.includes(kind)) {
    throw new AiRailsError(
      "ai_unknown_draft_kind",
      `unknown draft kind "${kind}" — draft from the review form, requisition, onboarding creation or offer letter`,
    );
  }
  await assertDraftFeature(exec, orgId);
  const sources = kind === "job_description"
    ? await collectJobDescription(exec, orgId, actorId, subjectId)
    : kind === "review_manager"
      ? await collectReview(exec, orgId, actorId, subjectId, false)
      : kind === "review_self"
        ? await collectReview(exec, orgId, actorId, subjectId, true)
        : kind === "onboarding_plan"
          ? await collectOnboardingPlan(exec, orgId, actorId, subjectId)
          : await collectOfferClauses(exec, orgId, actorId, subjectId);
  const text = renderOutline(kind, sources);
  const settings = await loadAiRailsSettings(exec, orgId);
  const biasFlags = flagBiasTerms(text, settings.biasTerms);
  // The service's ONLY write: the decision row. No draft is stored, no
  // form is filled, no record is created — the human submits.
  const decisionId = await logDecision(exec, {
    orgId,
    actorId,
    capabilityKey: "hrmDrafting",
    subjectKind: kind,
    subjectId,
    input: `draftFromEvidence ${kind} subject=${subjectId}`,
    output: `${text.length} chars from ${sources.length} sources`,
    outputSummary: `${kind} draft from ${sources.length} cited sources`,
    sources: sources.map((s) => ({ kind: s.kind, id: s.id })),
    outcome: "shown",
    model: "drafting-service",
  });
  return { kind, subjectId, text, sources, biasFlags, decisionId };
}

/** Public boundary: draft from evidence. One transaction. */
export async function draftWithEvidence(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly kind: DraftKind;
  readonly subjectId: string;
}): Promise<DraftResult> {
  return withOrgTransaction(query.orgId, () => draftFromEvidence(db, query));
}
