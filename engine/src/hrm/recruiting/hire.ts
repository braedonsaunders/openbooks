import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManage } from "../authorization.ts";
import { createChangeRequestDraft, submitChangeRequest } from "../change-requests.ts";
import { loadVacancyAsOf } from "../positions-read.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";
import { appendApplicationEvent, loadApplication, markApplicationHired } from "./applications.ts";
import { loadCandidate, linkCandidateParty } from "./candidates.ts";
import { hiredStage, loadPipelineTemplate } from "./pipeline.ts";
import { expireOfferIfPastDue, loadOffer } from "./offers.ts";
import { bumpFillForHire } from "./requisitions.ts";

/**
 * The recruiting hire (HR-6, 0195): accepting an offer opens ONE transaction
 * that (1) creates the employee party when the candidate has none (or
 * reuses it), (2) files a hire change request through the existing
 * change-request service and submits it for approval through Flows exactly
 * as a manually proposed hire, (3) records the offer link, the hired
 * application, and the requisition fill. Any refusal — a requisition gone
 * from open, a position no longer vacant as of the start date, a
 * change-request refusal — rolls the WHOLE transaction back: no party, no
 * draft, no fill without its approval path.
 *
 * The employment itself comes into existence when the change request is
 * approved, as today — recruiting never writes worker_employment_versions.
 * Only the reserved identity the change-request path requires is written
 * here, inside the same transaction that files the draft.
 */

export interface AcceptOfferAsHireQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly offerId: string;
}

export interface HireResult {
  readonly offerId: string;
  readonly applicationId: string;
  readonly requisitionId: string;
  readonly requisitionNumber: string;
  readonly employmentId: string;
  readonly workerPartyId: string;
  readonly changeRequestId: string;
  readonly requisitionStatus: string;
}

function isPositiveDecimal(value: string): boolean {
  return !value.startsWith("-") && !/^0(\.0+)?$/.test(value);
}

export async function acceptOfferAsHire(query: AcceptOfferAsHireQuery): Promise<HireResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const offerId = requireId(query.offerId, "offerId");
  // Expiry materialises in its own commit before the hire opens: the hire
  // itself must write nothing when refused.
  if (await expireOfferIfPastDue({ orgId, actorId, offerId })) {
    throw new RecruitingError(
      "BAD_STATE",
      "the offer expired before it was accepted — the expiry stands as recorded; draft new terms instead",
    );
  }
  return withOrgTransaction(orgId, async () => {
    const offer = await loadOfferForHire(db, orgId, offerId);
    const application = await loadApplication(db, orgId, offer.applicationId);
    if (!application) {
      throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
    }
    // Hire is a material employment commitment: the org-wide manage grant,
    // never the hiring-manager override (which covers reads and moves).
    await requireHrmRecruitingManage(db, orgId, actorId, application.requisitionId);
    const requisition = await loadRequisitionForHire(db, orgId, application.requisitionId);
    if (requisition.status !== "open") {
      throw new RecruitingError(
        "BAD_STATE",
        `requisition ${requisition.requisitionNumber} is ${requisition.status} — hires land only on open requisitions`,
      );
    }
    if (application.status !== "active") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${application.status} application cannot be hired — only active candidacies hire`,
      );
    }
    if (offer.status === "expired") {
      throw new RecruitingError(
        "BAD_STATE",
        "the offer expired before it was accepted — the expiry stands as recorded; draft new terms instead",
      );
    }
    if (offer.status !== "sent") {
      throw new RecruitingError("BAD_STATE", `a ${offer.status} offer cannot be accepted — only sent offers accept`);
    }
    const candidate = await loadCandidate(db, orgId, application.candidateId);
    if (!candidate) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
    }
    // The offer's position must agree with the requisition's vacancy: a
    // hire against a different establishment than the opening is refused,
    // never silently re-pointed.
    const effectivePositionId = offer.positionId ?? requisition.positionId;
    if (offer.positionId && requisition.positionId && offer.positionId !== requisition.positionId) {
      throw new RecruitingError(
        "REFUSED",
        "the offer names a different position than the requisition — re-draft the offer against the opening's position instead of hiring across establishments",
      );
    }
    if (effectivePositionId) {
      await assertPositionVacantForHire(db, orgId, actorId, effectivePositionId, offer.proposedStartOn);
    }
    if (!requisition.pipelineTemplateId) {
      throw new RecruitingError("REFUSED", "the requisition names no pipeline — re-open it onto a live funnel before hiring");
    }
    const template = await loadPipelineTemplate(db, orgId, requisition.pipelineTemplateId);
    if (!template) {
      throw new RecruitingError("REFUSED", "the requisition's pipeline is gone — re-open the requisition onto a live funnel before hiring");
    }
    const hired = hiredStage(template);

    // (1) The employee party: reuse the candidate's link, or create the
    // person row the reserved employment will name.
    let workerPartyId = candidate.partyId;
    if (!workerPartyId) {
      workerPartyId = randomUUID();
      const created = (await db.execute<{ id: string }>(sql`
        insert into parties (id, org_id, kind, display_name, email, phone, is_active, custom, created_by, updated_by)
        values (${workerPartyId}, ${orgId}, 'person', ${candidate.displayName},
                ${candidate.email}, ${candidate.phone}, true, '{}'::jsonb, ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!created) {
        throw new RecruitingError("REFUSED", "the employee party was not stored — no row was written; retry the hire");
      }
      await linkCandidateParty(db, { orgId, actorId, candidateId: candidate.id, partyId: workerPartyId });
    }

    // The reserved employment identity the hire change requires
    // (version-less, revision 1 — the approval applies the first version).
    const employmentId = randomUUID();
    const reserved = (await db.execute<{ id: string }>(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${employmentId}, ${orgId}, ${workerPartyId}, ${offer.employerSubsidiaryId}, 1)
      returning id
    `)).rows[0];
    if (!reserved) {
      throw new RecruitingError("REFUSED", "the reserved employment was not stored — no row was written; retry the hire");
    }

    // (2) The hire change request through the existing service, submitted
    // for approval through Flows exactly as a manually proposed hire. Both
    // join THIS transaction (withOrgTransaction reuses the pinned
    // transaction for the same org), so a refusal rolls the party, the
    // reserved identity, and every hire write below back together.
    const draft = await createChangeRequestDraft({
      orgId,
      actorId,
      employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: offer.proposedStartOn },
    });
    const submitted = await submitChangeRequest({
      orgId,
      actorId,
      requestId: draft.id,
      reason: `Hire for requisition ${requisition.requisitionNumber}: ${offer.jobTitle}`,
    });
    if (submitted.status !== "pending_approval") {
      throw new RecruitingError(
        "REFUSED",
        "the hire change request did not reach approval — the hire is refused rather than recorded without its approval path",
      );
    }

    // (3) The hire evidence: offer link, hired application, requisition fill.
    const acceptedOffer = (await db.execute<{ id: string }>(sql`
      update hrm_offers
         set status = 'accepted', responded_at = now(), approved_change_id = ${submitted.id},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${offerId} and status = 'sent'
      returning id
    `)).rows[0];
    if (!acceptedOffer) {
      throw new RecruitingError("REFUSED", "the offer changed while hiring — the hire is refused rather than recorded twice");
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId: application.id,
      kind: "offer_accepted",
      reason: `terms accepted: ${offer.jobTitle}`,
    });
    await markApplicationHired(db, {
      orgId,
      actorId,
      applicationId: application.id,
      employmentId,
      hiredStageId: hired.id,
    });
    const filled = await bumpFillForHire(db, {
      orgId,
      actorId,
      requisitionId: requisition.id,
      expectedRevision: requisition.revision,
    });
    // HR-12: a hire against a headcount-plan requisition marks the plan
    // line filled — informational workforce tracking, never an employment
    // write. Runs in the hire transaction, so a hire refusal unmarks.
    const { markPlanLineFilledForRequisition } = await import("../compensation/headcount-plans.ts");
    await markPlanLineFilledForRequisition(orgId, requisition.id);
    return {
      offerId,
      applicationId: application.id,
      requisitionId: requisition.id,
      requisitionNumber: requisition.requisitionNumber,
      employmentId,
      workerPartyId,
      changeRequestId: submitted.id,
      requisitionStatus: filled.status,
    };
  });
}

type HireOfferRow = {
  id: string;
  applicationId: string;
  positionId: string | null;
  employerSubsidiaryId: string;
  jobTitle: string;
  proposedStartOn: string;
  status: string;
  expiresOn: string | null;
};

async function loadOfferForHire(exec: SqlExecutor, orgId: string, offerId: string): Promise<HireOfferRow> {
  const offer = await loadOffer(exec, orgId, offerId);
  if (!offer) {
    throw new RecruitingError("NOT_FOUND", "offer is not visible in this organization");
  }
  return {
    id: offer.id,
    applicationId: offer.applicationId,
    positionId: offer.positionId,
    employerSubsidiaryId: offer.employerSubsidiaryId,
    jobTitle: offer.jobTitle,
    proposedStartOn: offer.proposedStartOn,
    status: offer.status,
    expiresOn: offer.expiresOn,
  };
}

type HireRequisitionRow = {
  id: string;
  requisitionNumber: string;
  positionId: string | null;
  status: string;
  revision: number;
  pipelineTemplateId: string | null;
};

async function loadRequisitionForHire(
  exec: SqlExecutor,
  orgId: string,
  requisitionId: string,
): Promise<HireRequisitionRow> {
  const row = (await exec.execute<HireRequisitionRow>(sql`
    select id, requisition_number as "requisitionNumber", position_id as "positionId",
           status, revision, pipeline_template_id as "pipelineTemplateId"
      from hrm_requisitions
     where org_id = ${orgId} and id = ${requisitionId} for update
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "requisition is not visible in this organization");
  }
  return row;
}

/**
 * The position must STILL be vacant as of the start date when the hire
 * lands: a vacancy proven at opening can fill under us. Refused outright —
 * hire carries no over-establishment override; re-open the headcount first.
 */
async function assertPositionVacantForHire(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  positionId: string,
  startOn: string,
): Promise<void> {
  const vacancy = await loadVacancyAsOf(exec, {
    orgId,
    actorId,
    effectiveDate: startOn,
    knownAt: new Date().toISOString(),
  });
  const row = vacancy.positions.find((position) => position.id === positionId);
  if (!row) {
    throw new RecruitingError(
      "REFUSED",
      "the position shows no vacancy row as of the start date — resolve the position before hiring",
    );
  }
  if (row.vacancy.refusal) {
    throw new RecruitingError("REFUSED", row.vacancy.refusal.message);
  }
  if (!isPositiveDecimal(row.vacancy.vacantFte)) {
    throw new RecruitingError(
      "REFUSED",
      `the position is no longer vacant as of ${startOn} — the hire is refused rather than recruited past the plan`,
    );
  }
}
