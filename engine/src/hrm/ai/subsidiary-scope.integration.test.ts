import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { mkEmployment, mkParty, refusalOf, seedEmployment } from "../../testing/hrm-harness.ts";
import { countRows, refusal, scopeMatrix, scopeRow, type ScopeWorld } from "../../testing/hrm-scope-matrix.ts";
import { AiRailsError } from "./errors.ts";
import { draftFromEvidence } from "./drafting.ts";
import { explainPay } from "./explain-pay.ts";
import { logDecision, markDecision } from "./governance.ts";

/**
 * AI capabilities over HRM and payroll records under a legal-entity lens. Pay explanations, evidence
 * drafts and decision marks reach only subjects inside the actor's allowed
 * employers; an out-of-scope subject refuses like an unknown one (or, for a
 * draft, with the remedy), and a refusal writes no decision row.
 */

/** Helpers only need the org; any actor set satisfies this. */
type World = ScopeWorld<never>;

const employment = (w: World, partyId: string, subsidiaryId: string) => mkEmployment(w.orgId, partyId, subsidiaryId, {});

/** A pending review in FY26; a calibrated rating adds a shared FY25 review, the prior a draft cites. */
async function review(w: World, actorId: string, employmentId: string, subject: string, reviewer: string, kind: "self" | "manager", calibrated?: string) {
  const templateId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
    values (${w.orgId}, ${`Annual ${randomUUID().slice(0, 8)}`}, '{"min": 1, "max": 5}'::jsonb, ${actorId}, ${actorId}) returning id`)).rows[0]!.id;
  const cycle = async (name: string, year: number) => (await db.execute<{ id: string }>(sql`
    insert into hrm_review_cycles (org_id, template_id, name, period_start_on, period_end_on)
    values (${w.orgId}, ${templateId}, ${name}, ${`${year}-01-01`}, ${`${year}-12-31`}) returning id`)).rows[0]!.id;
  if (calibrated) {
    await db.execute(sql`
      insert into hrm_reviews (org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id, kind, status,
        overall_rating, calibrated_rating, calibration_reason, submitted_at, shared_at)
      values (${w.orgId}, ${await cycle("FY25", 2025)}, ${employmentId}, ${subject}, ${reviewer}, 'manager', 'shared',
        ${calibrated}, ${calibrated}, 'calibrated', now(), now())`);
  }
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_reviews (org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id, kind, status)
    values (${w.orgId}, ${await cycle("FY26", 2026)}, ${employmentId}, ${subject}, ${reviewer}, ${kind}, 'pending') returning id`)).rows[0]!.id;
}

const logDraft = (w: World, actorId: string, subjectKind: string, subjectId: string) => logDecision(db, {
  orgId: w.orgId, actorId, capabilityKey: "hrmDrafting", subjectKind, subjectId,
  input: `draftFromEvidence ${subjectKind} subject=${subjectId}`, output: "outline",
  outputSummary: `${subjectKind} draft from 1 cited sources`, sources: [{ kind: "hrm_review", id: subjectId }],
  outcome: "shown", model: "drafting-service",
});

async function markDenied(promise: Promise<unknown>, label: string): Promise<void> {
  const error = await refusal(promise, AiRailsError);
  assert.equal(error.code, "ai_decision_missing", `${label}: refusal must read as uniform not-found`);
}

const outcomes = (w: World) => countRows(sql`from ai_decisions where org_id = ${w.orgId} and outcome in ('accepted', 'edited', 'rejected')`);

const SELF = { scope: "direct", permissions: ["hrm.self.read"], link: true } as const;
const MANAGER = { scope: "direct", permissions: ["hrm.performance.manage"], link: true } as const;

scopeMatrix([
  scopeRow({
    name: "explaining pay needs the employment inside the actor's legal-entity scope",
    features: ["payroll"],
    actors: {
      payrollA: { scope: "A", permissions: ["payroll.manage"] },
      hrA: { scope: "A", permissions: ["hrm.employment.read"] },
      hrFull: { scope: "direct", permissions: ["hrm.employment.read"] },
    },
    seed: async (w) => ({
      empA: (await seedEmployment(w.orgId, w.subA, { displayName: "Explain Worker", withVersion: false })).employmentId,
      empB: (await seedEmployment(w.orgId, w.subB, { displayName: "Explain Worker", withVersion: false })).employmentId,
    }),
    read: async (w, { empA, empB }) => {
      const explain = (actorId: string, employmentId: string) => explainPay(db, { orgId: w.orgId, actorId, employmentId });
      for (const [name, actorId] of [["payroll.manage", w.payrollA], ["hrm.employment.read", w.hrA]] as const) {
        // No stubs are seeded: B refusing as missing while A reaches the stub lookup proves the scope gate fired.
        const hidden = await refusalOf(explain(actorId, empB), AiRailsError);
        assert.deepEqual(hidden, await refusalOf(explain(actorId, randomUUID())), `${name}: B must refuse identically to unknown`);
        assert.equal(hidden.code, "ai_subject_missing");
        assert.equal((await refusal(explain(actorId, empA), AiRailsError)).code, "ai_no_payslip", `${name}: in-scope employment must pass scope`);
      }
      assert.equal((await refusal(explain(w.hrFull, empB), AiRailsError)).code, "ai_no_payslip", "unrestricted HR passes the gate");
    },
  }),
  scopeRow({
    name: "a restricted HR drafts manager reviews only inside their legal-entity scope",
    actors: {
      worker: SELF,
      manager: MANAGER,
      hrA: { scope: "A", permissions: ["hrm.performance.manage", "hrm.retention.read", "hrm.recruiting.read"], link: true },
    },
    write: async (w) => {
      const orgId = w.orgId;
      const reviewB = await review(w, w.manager, await employment(w, w.party.worker, w.subB), w.party.worker, w.party.manager, "manager", "4.7500");
      const requisitionB = (await db.execute<{ id: string }>(sql`
        insert into hrm_requisitions (org_id, requisition_number, title, employer_subsidiary_id, headcount, created_by, updated_by)
        values (${orgId}, ${`AI-${randomUUID()}`}, 'B-side role', ${w.subB}, 1, ${w.manager}, ${w.manager}) returning id`)).rows[0]!.id;
      const decisions = () => countRows(sql`from ai_decisions where org_id = ${orgId} and capability_key = 'hrmDrafting'`);
      const before = await decisions();

      const job = await refusal(draftFromEvidence(db, { orgId, actorId: w.hrA, kind: "job_description", subjectId: requisitionB }), AiRailsError);
      assert.equal(job.code, "ai_subject_missing");
      const error = await refusal(draftFromEvidence(db, { orgId, actorId: w.hrA, kind: "review_manager", subjectId: reviewB }), AiRailsError, /outside your allowed subsidiaries/);
      assert.equal(error.code, "ai_subject_refused");
      assert.match(error.message, /HR covering that subsidiary/, "the whole draft refuses with the remedy");
      assert.equal(await decisions(), before, "a refused draft writes no decision row");

      const draft = await draftFromEvidence(db, { orgId, actorId: w.manager, kind: "review_manager", subjectId: reviewB });
      assert.match(draft.text, /4\.75/, "the assigned reviewer's draft cites the prior calibrated rating");
    },
  }),
  scopeRow({
    name: "a self-service user cannot mark another user's decision; the recipient can",
    actors: { recipient: SELF, stranger: { scope: "direct", permissions: ["hrm.self.read"] } },
    write: async (w) => {
      const party = w.party.recipient;
      const reviewId = await review(w, w.recipient, await employment(w, party, w.subA), party, party, "self");
      const decisionId = await logDraft(w, w.recipient, "review_self", reviewId);
      const before = await outcomes(w);
      await markDenied(markDecision(db, { orgId: w.orgId, actorId: w.stranger, decisionId, outcome: "accepted" }), "stranger");
      assert.equal(await outcomes(w), before, "a refused mark writes no ledger row");
      const marked = await markDecision(db, { orgId: w.orgId, actorId: w.recipient, decisionId, outcome: "accepted" });
      assert.ok(marked.length > 0, "the recipient records the outcome");
      assert.equal(await outcomes(w), before + 1);
    },
  }),
  scopeRow({
    name: "marking a reviewer decision needs the grant, the subject relationship, and the subsidiary",
    actors: {
      worker: { scope: "direct", permissions: ["hrm.self.read", "hrm.performance.read"], link: true },
      manager: MANAGER,
      scopedHr: { scope: "A", permissions: ["hrm.performance.manage", "hrm.retention.read"] },
    },
    write: async (w) => {
      const decisionFor = async (subject: string, subsidiaryId: string) => {
        const reviewId = await review(w, w.manager, await employment(w, subject, subsidiaryId), subject, w.party.manager, "manager");
        return logDraft(w, w.manager, "review_manager", reviewId);
      };
      const decisionA = await decisionFor(w.party.worker, w.subA);
      const decisionB = await decisionFor(await mkParty(w.orgId, "Worker B"), w.subB);
      const mark = (actorId: string, decisionId: string, outcome: "accepted" | "edited") => markDecision(db, { orgId: w.orgId, actorId, decisionId, outcome });

      await markDenied(mark(w.worker, decisionA, "edited"), "a same-entity non-reviewer without the manage grant");
      assert.ok((await mark(w.manager, decisionA, "edited")).length > 0, "the assigned manager marks in scope");
      await markDenied(mark(w.scopedHr, decisionB, "accepted"), "HR reviewer outside the subject's subsidiary");
      assert.ok((await mark(w.scopedHr, decisionA, "accepted")).length > 0, "the same HR reviewer marks the in-scope decision");
    },
  }),
]);
