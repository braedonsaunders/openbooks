import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { isFeatureEnabled } from "../features";
import { notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { settleTalentRefusal, talentCommand, type TalentCommandInput } from "./talent-tools-shared";
import {
  createRequisitionBody,
  patchRequisitionBody,
} from "@/app/api/hrm/recruiting/requisitions/bodies";
import { createCandidateBody } from "@/app/api/hrm/recruiting/candidates/bodies";
import { attachCandidateBody } from "@/app/api/hrm/recruiting/attachments/bodies";
import {
  createApplicationBody,
  patchApplicationBody,
} from "@/app/api/hrm/recruiting/applications/bodies";
import {
  recordConsentBody,
  withdrawConsentBody,
} from "@/app/api/hrm/recruiting/candidates/[id]/consents/bodies";
import { createOfferBody, patchOfferBody } from "@/app/api/hrm/recruiting/offers/bodies";
import {
  scheduleInterviewBody,
  patchInterviewBody,
} from "@/app/api/hrm/recruiting/interviews/bodies";
import {
  publishPostingBody,
  transitionPostingBody,
} from "@/app/api/hrm/recruiting/postings/bodies";
import {
  createKitBody,
  setKitActiveBody,
  createAttributeBody,
  createQuestionBody,
} from "@/app/api/hrm/recruiting/kits/bodies";
import {
  createTalentPoolBody,
  addPoolMemberBody,
  removePoolMemberBody,
  tagCandidateBody,
  rediscoverBody,
} from "@/app/api/hrm/recruiting/talent-pools/bodies";
import { createRetentionRuleBody } from "@/app/api/hrm/recruiting/retention-rules/bodies";
import { createOfferTemplateBody } from "@/app/api/hrm/recruiting/offer-templates/bodies";
import { submitScorecardBody } from "@/app/api/hrm/recruiting/interviews/[id]/scorecards/bodies";
import { proposeSlotsBody } from "@/app/api/hrm/recruiting/interviews/[id]/slots/bodies";
import { renderOfferVersionBody } from "@/app/api/hrm/recruiting/offers/[id]/versions/bodies";
import { offerSigningBody } from "@/app/api/hrm/recruiting/offers/[id]/signing/bodies";
import {
  createRequisition,
  openRequisition,
  holdRequisition,
  resumeRequisition,
  reviseRequisition,
  cancelRequisition,
} from "@openbooks/engine/hrm/recruiting/requisitions";
import { createCandidate } from "@openbooks/engine/hrm/recruiting/candidates";
import {
  attachCandidate,
  createApplication,
  moveApplicationStage,
  rejectApplication,
  withdrawApplication,
} from "@openbooks/engine/hrm/recruiting/applications";
import { recordConsent, withdrawConsent } from "@openbooks/engine/hrm/recruiting/retention";
import {
  createOffer,
  declineOffer,
  sendOffer,
  withdrawOffer,
} from "@openbooks/engine/hrm/recruiting/offers";
import { acceptOfferAsHire } from "@openbooks/engine/hrm/recruiting/hire";
import {
  scheduleInterview,
  completeInterview,
  cancelInterview,
} from "@openbooks/engine/hrm/recruiting/interviews";
import {
  publishPosting,
  pausePosting,
  closePosting,
} from "@openbooks/engine/hrm/recruiting/postings";
import {
  createKit,
  setKitActive,
  deleteKit,
  addKitAttribute,
  addKitQuestion,
} from "@openbooks/engine/hrm/recruiting/kits";
import {
  createTalentPool,
  deleteTalentPool,
  addPoolMember,
  removePoolMember,
  tagCandidate,
  rediscoverForRequisition,
} from "@openbooks/engine/hrm/recruiting/pools";
import {
  createRetentionRule,
  evaluateRetentionRule,
} from "@openbooks/engine/hrm/recruiting/retention";
import {
  createOfferTemplate,
  renderOfferVersion,
  sendOfferLink,
  voidOfferSignature,
} from "@openbooks/engine/hrm/recruiting/offers-signing";
import { proposeSlots } from "@openbooks/engine/hrm/recruiting/scheduling";
import { submitScorecard } from "@openbooks/engine/hrm/recruiting/scorecards";
import { getCandidateDetail } from "@openbooks/engine/hrm/recruiting/recruiting-read";

const FEATURE = "hrmRecruiting";
const MANAGE = "hrm.recruiting.manage";
const READ = "hrm.recruiting.read";
const actor = (context: ApplicationContext) => ({
  orgId: context.authz.user.orgId,
  actorId: context.authz.user.id,
});
const offerHref = "/hrm/recruiting";
function recruitingHref(result: Record<string, unknown>, input: TalentCommandInput): string {
  const idOf = (value: unknown): string | undefined =>
    value && typeof value === "object" && "id" in value && typeof value.id === "string"
      ? value.id
      : undefined;
  const recordName = input.recordName;
  const resultType = [
    "requisition",
    "candidate",
    "application",
    "offer",
    "interview",
    "posting",
    "pool",
    "kit",
    "template",
  ].find((key) => idOf(result[key]) !== undefined);
  const type =
    recordName === "requisitionId"
      ? "requisition"
      : recordName === "candidateId"
        ? "candidate"
        : recordName === "applicationId"
          ? "application"
          : recordName === "offerId"
            ? "offer"
            : recordName === "interviewId"
              ? "interview"
              : recordName === "postingId"
                ? "posting"
                : recordName === "poolId"
                  ? "pool"
                  : resultType;
  const id = input.recordId ?? (type ? idOf(result[type]) : undefined);
  if (!id) return offerHref;
  const encoded = encodeURIComponent(id);
  switch (type) {
    case "requisition":
      return `${offerHref}?requisition=${encoded}`;
    case "candidate":
      return `${offerHref}?candidate=${encoded}`;
    case "application":
      return `${offerHref}?tab=applications&application=${encoded}`;
    case "offer":
      return `${offerHref}?tab=offers&offer=${encoded}`;
    case "interview":
      return `${offerHref}?tab=interviews&interview=${encoded}`;
    case "posting":
      return `${offerHref}?tab=postings&posting=${encoded}`;
    case "pool":
      return `${offerHref}?tab=pools&pool=${encoded}`;
    case "kit":
    case "template":
      return `${offerHref}?tab=interviews`;
    default:
      return offerHref;
  }
}

export const RECRUITING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  talentCommand({
    name: "create_requisition",
    title: "Create Requisition",
    description:
      "Create a draft hiring requisition with an approved position, legal employer and headcount. Find position and employer ids with the HRM workforce reads, then verify the result with hrm_recruiting.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createRequisitionBody,
    payloadDescription:
      "Requisition fields: title or jobDescriptionId, employerSubsidiaryId, headcount, and optional position, recruiter, hiring manager, location, dates, compensation, pipeline, and description.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      requisition: await createRequisition({ ...actor(context), ...p } as never),
    }),
  }),
  ...(["open", "hold", "resume", "revise", "cancel"] as const).map((action) =>
    talentCommand({
      name: `${action}_requisition`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Requisition`,
      description: `${action} a requisition through its governed lifecycle. Use hrm_recruiting to find the requisition id and verify its resulting state.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "requisitionId", description: "Requisition id from hrm_recruiting." },
      bodySchema: patchRequisitionBody,
      payloadDescription: `Native requisition ${action} body; include action: "${action}" and the required reason, revision, or opening fields.`,
      destructive: action === "cancel",
      href: recruitingHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; [key: string]: unknown };
        const id = input.recordId!;
        const common = { ...actor(context), requisitionId: id };
        if (action === "open")
          return {
            requisition: await openRequisition({
              ...common,
              targetStartOn: body.targetStartOn as string | null | undefined,
              overEstablishment: body.overEstablishment as boolean | undefined,
            }),
          };
        if (action === "hold")
          return {
            requisition: await holdRequisition({ ...common, reason: body.reason as string }),
          };
        if (action === "resume")
          return {
            requisition: await resumeRequisition({ ...common, reason: body.reason as string }),
          };
        if (action === "revise")
          return {
            requisition: await reviseRequisition({
              ...common,
              expectedRevision: body.expectedRevision as number,
              title: body.title as string | undefined,
              employmentKind: body.employmentKind as string | null | undefined,
              compensation: body.compensation as never,
              description: body.description as string | null | undefined,
            }),
          };
        return {
          requisition: await cancelRequisition({ ...common, reason: body.reason as string }),
        };
      },
    }),
  ),
  talentCommand({
    name: "create_candidate",
    title: "Create Candidate",
    description:
      "Create or explicitly merge a recruiting candidate. Use hrm_recruiting to find the candidate id and verify the PII-scoped result.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createCandidateBody,
    payloadDescription:
      "Candidate fields: displayName and optional email, phone, source, resume attachment, internal-candidate flag, notes, or mergeInto survivor id.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      ...(await createCandidate({ ...actor(context), ...p } as never)),
    }),
  }),
  talentCommand({
    name: "attach_candidate_to_requisition",
    title: "Attach Candidate to Requisition",
    description:
      "Create or merge a candidate and attach them to an open requisition in one transaction. Find the requisition and any merge candidate id with hrm_recruiting reads, then verify the application and candidate there.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: attachCandidateBody,
    payloadDescription:
      "Requisition id, candidate name, optional email and phone, and optional survivor candidate id for a duplicate merge.",
    href: (result) => {
      const attached = result.attached;
      const application =
        attached && typeof attached === "object" && "application" in attached
          ? attached.application
          : null;
      const id =
        application && typeof application === "object" && "id" in application
          ? application.id
          : null;
      return typeof id === "string"
        ? `${offerHref}?tab=applications&application=${encodeURIComponent(id)}`
        : offerHref;
    },
    invoke: async (context, _input, p) => ({
      attached: await attachCandidate({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "create_application",
    title: "Create Application",
    description:
      "Attach a candidate to an open requisition at its first pipeline stage. Find both ids with hrm_recruiting, then verify the application there.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createApplicationBody,
    payloadDescription:
      "Application fields: requisitionId, candidateId, and whether the candidate was merged into the named survivor.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      application: await createApplication({ ...actor(context), ...p } as never),
    }),
  }),
  ...(["move", "reject", "withdraw"] as const).map((action) =>
    talentCommand({
      name: action === "move" ? "move_application_stage" : `${action}_application`,
      title:
        action === "move"
          ? "Move Application Stage"
          : `${action[0]!.toUpperCase()}${action.slice(1)} Application`,
      description: `${action} a candidate application through its recorded pipeline transition. Find application and stage ids with hrm_recruiting, then verify the new stage or terminal state there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "applicationId", description: "Application id from hrm_recruiting." },
      bodySchema: patchApplicationBody,
      payloadDescription: `Native application ${action} body; include action: "${action}" and the target stage or refusal reason where required.`,
      destructive: action !== "move",
      href: recruitingHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; [key: string]: unknown };
        const common = { ...actor(context), applicationId: input.recordId! };
        if (action === "move")
          return {
            application: await moveApplicationStage({
              ...common,
              expectedStageId: body.expectedStageId as string | undefined,
              toStageId: body.toStageId as string,
              reason: body.reason as string | null | undefined,
            }),
          };
        if (action === "reject")
          return {
            application: await rejectApplication({
              ...common,
              expectedStageId: body.expectedStageId as string | undefined,
              reason: body.reason as string,
            }),
          };
        return { application: await withdrawApplication(common) };
      },
    }),
  ),
  talentCommand({
    name: "record_candidate_consent",
    title: "Record Candidate Consent",
    description:
      "Record a candidate's consent for a named processing purpose with its retention period. Find the candidate id with hrm_recruiting and verify the consent audit record there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "candidateId", description: "Candidate id from hrm_recruiting." },
    bodySchema: recordConsentBody,
    payloadDescription:
      "Consent purpose, scope, consent date, and any expiry or evidence fields accepted by the native consent route.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      consent: await recordConsent({
        ...actor(context),
        candidateId: input.recordId!,
        ...p,
      } as never),
    }),
  }),
  talentCommand({
    name: "withdraw_candidate_consent",
    title: "Withdraw Candidate Consent",
    description:
      "Withdraw a recorded candidate consent with its governed reason. Find the candidate and consent ids with hrm_recruiting, then verify the consent state there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "candidateId", description: "Candidate id from hrm_recruiting." },
    bodySchema: withdrawConsentBody,
    payloadDescription: "Consent id and reason required to withdraw the candidate's prior consent.",
    destructive: true,
    href: recruitingHref,
    invoke: async (context, input, p) => {
      await withdrawConsent({ ...actor(context), candidateId: input.recordId!, ...p } as never);
      return { withdrawn: input.recordId! };
    },
  }),
  talentCommand({
    name: "create_offer",
    title: "Create Offer",
    description:
      "Draft exact offer terms for an active application. Find the application, position, employer and department ids with hrm_recruiting and verify the offer there.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createOfferBody,
    payloadDescription:
      "Offer fields: application, job title, legal employer, proposed start date, exact decimal compensation amount, currency, basis, and optional position, department, employment kind, expiry.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      offer: await createOffer({ ...actor(context), ...p } as never),
    }),
  }),
  ...(["send", "accept", "decline", "withdraw"] as const).map((action) =>
    talentCommand({
      name: `${action}_offer`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Offer`,
      description: `${action} an offer through the recruiting lifecycle${action === "accept" ? ", which creates the hire hand-off into employment" : ""}. Find the offer id with hrm_recruiting and verify the resulting offer or hire there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "offerId", description: "Offer id from hrm_recruiting." },
      bodySchema: patchOfferBody,
      payloadDescription: `Native offer action body; include action: "${action}"${action === "decline" || action === "withdraw" ? " and a reason" : ""}.`,
      destructive: action === "decline" || action === "withdraw",
      href: recruitingHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; reason?: string };
        const common = { ...actor(context), offerId: input.recordId! };
        if (action === "send") return { offer: await sendOffer(common) };
        if (action === "accept") return { hire: await acceptOfferAsHire(common) };
        if (action === "decline")
          return { offer: await declineOffer({ ...common, reason: body.reason! }) };
        return { offer: await withdrawOffer({ ...common, reason: body.reason! }) };
      },
    }),
  ),
  talentCommand({
    name: "schedule_interview",
    title: "Schedule Interview",
    description:
      "Schedule a structured interview on an active application and name its panel. Find application and panelist ids with hrm_recruiting; verify the interview there.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: scheduleInterviewBody,
    payloadDescription:
      "Interview fields: applicationId, kind, ISO scheduledAt with offset, optional duration, location, panelPartyIds, kitId and panelFocus.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      interview: await scheduleInterview({ ...actor(context), ...p } as never),
    }),
  }),
  ...(["complete", "cancel"] as const).map((action) =>
    talentCommand({
      name: `${action}_interview`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Interview`,
      description: `${action} a scheduled interview and retain its outcome evidence. Find the interview id with hrm_recruiting and verify its state there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "interviewId", description: "Interview id from hrm_recruiting." },
      bodySchema: patchInterviewBody,
      payloadDescription: `Native interview ${action} body; include action: "${action}"${action === "complete" ? " and outcome, optional feedback and scorecard" : ""}.`,
      destructive: action === "cancel",
      href: recruitingHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; [key: string]: unknown };
        const common = { ...actor(context), interviewId: input.recordId! };
        if (action === "cancel") return { interview: await cancelInterview(common) };
        return {
          interview: await completeInterview({
            ...common,
            outcome: body.outcome as "advance" | "hold" | "reject",
            feedback: body.feedback as string | null | undefined,
            scorecard: body.scorecard,
          }),
        };
      },
    }),
  ),
  talentCommand({
    name: "submit_interview_scorecard",
    title: "Submit Interview Scorecard",
    description:
      "Submit a panelist's scorecard for a scheduled interview. Find the interview and attribute ids with hrm_recruiting, then verify the scorecard there.",
    permission: READ,
    featureKey: FEATURE,
    recordId: { name: "interviewId", description: "Interview id from hrm_recruiting." },
    bodySchema: submitScorecardBody,
    payloadDescription:
      "Scorecard answers and reviewer identity accepted by the native scorecard route.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      scorecard: await submitScorecard({
        ...actor(context),
        interviewId: input.recordId!,
        ...p,
      } as never),
    }),
  }),
  talentCommand({
    name: "propose_interview_slots",
    title: "Propose Interview Slots",
    description:
      "Propose availability slots to an interview candidate. Find the interview id with hrm_recruiting and verify the slots there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "interviewId", description: "Interview id from hrm_recruiting." },
    bodySchema: proposeSlotsBody,
    payloadDescription: "Slot proposals accepted by the native interview scheduling route.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      ...(await proposeSlots({ ...actor(context), interviewId: input.recordId!, ...p } as never)),
    }),
  }),
  talentCommand({
    name: "publish_job_posting",
    title: "Publish Job Posting",
    description:
      "Publish an open requisition to a configured job board. Find the requisition id and board key with hrm_recruiting, then verify the posting there.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: publishPostingBody,
    payloadDescription: "Posting fields: requisitionId and configured boardKey.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      posting: await publishPosting({ ...actor(context), ...p } as never),
    }),
  }),
  ...(["pause", "close"] as const).map((action) =>
    talentCommand({
      name: `${action}_job_posting`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Job Posting`,
      description: `${action} a published job-board posting. Find the posting id with hrm_recruiting and verify its state there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "postingId", description: "Posting id from hrm_recruiting." },
      bodySchema: transitionPostingBody,
      payloadDescription: `Posting transition body with action: "${action}".`,
      destructive: action === "close",
      href: recruitingHref,
      invoke: async (context, input) => {
        const common = { ...actor(context), postingId: input.recordId! };
        return {
          posting: action === "pause" ? await pausePosting(common) : await closePosting(common),
        };
      },
    }),
  ),
  talentCommand({
    name: "create_interview_kit",
    title: "Create Interview Kit",
    description:
      "Create a structured interview kit for a hiring funnel stage. Find a pipeline stage id with hrm_recruiting and verify the kit there.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createKitBody,
    payloadDescription:
      "Kit fields: name, optional pipelineStageId, instructions and a rating scale.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      kit: await createKit({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "set_interview_kit_active",
    title: "Set Interview Kit Active",
    description:
      "Activate or deactivate an interview kit while preserving its history. Find the kit id with hrm_recruiting and verify the state there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "kitId", description: "Interview kit id from hrm_recruiting." },
    bodySchema: setKitActiveBody,
    payloadDescription: "Set action with action: " + '"setActive"' + " and isActive true or false.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      kit: await setKitActive({ ...actor(context), kitId: input.recordId!, ...p } as never),
    }),
  }),
  talentCommand({
    name: "delete_interview_kit",
    title: "Delete Interview Kit",
    description:
      "Delete an unused interview kit. Find its id with hrm_recruiting; kits referenced by interviews refuse deletion.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "kitId", description: "Interview kit id from hrm_recruiting." },
    destructive: true,
    href: recruitingHref,
    invoke: async (context, input) => {
      await deleteKit({ ...actor(context), kitId: input.recordId! });
      return { deleted: input.recordId! };
    },
  }),
  talentCommand({
    name: "add_interview_kit_attribute",
    title: "Add Interview Kit Attribute",
    description:
      "Add a scored attribute to an interview kit. Find the kit id with hrm_recruiting and verify the question structure there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "kitId", description: "Interview kit id from hrm_recruiting." },
    bodySchema: createAttributeBody,
    payloadDescription:
      "Attribute category, label, position and optional description and focus default.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      attribute: await addKitAttribute({
        ...actor(context),
        kitId: input.recordId!,
        ...p,
      } as never),
    }),
  }),
  talentCommand({
    name: "add_interview_kit_question",
    title: "Add Interview Kit Question",
    description:
      "Add a question to an interview kit. Find the kit and optional attribute ids with hrm_recruiting, then verify the kit there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "kitId", description: "Interview kit id from hrm_recruiting." },
    bodySchema: createQuestionBody,
    payloadDescription: "Question text, position and optional attributeId.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      question: await addKitQuestion({ ...actor(context), kitId: input.recordId!, ...p } as never),
    }),
  }),
  talentCommand({
    name: "create_talent_pool",
    title: "Create Talent Pool",
    description:
      "Create a named candidate pool for reusable sourcing. Verify it with hrm_recruiting.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createTalentPoolBody,
    payloadDescription: "Talent pool name and optional description.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      pool: await createTalentPool({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "delete_talent_pool",
    title: "Delete Talent Pool",
    description:
      "Delete a talent pool after its members are no longer needed. Find the pool id with hrm_recruiting and verify the deletion there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "poolId", description: "Talent pool id from hrm_recruiting." },
    destructive: true,
    href: recruitingHref,
    invoke: async (context, input) => {
      await deleteTalentPool({ ...actor(context), poolId: input.recordId! });
      return { deleted: input.recordId! };
    },
  }),
  talentCommand({
    name: "add_talent_pool_member",
    title: "Add Talent Pool Member",
    description:
      "Add a candidate to a talent pool with an optional note. Find candidate and pool ids with hrm_recruiting, then verify membership there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "poolId", description: "Talent pool id from hrm_recruiting." },
    bodySchema: addPoolMemberBody,
    payloadDescription: "Candidate id and optional membership note.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      member: await addPoolMember({ ...actor(context), poolId: input.recordId!, ...p } as never),
    }),
  }),
  talentCommand({
    name: "remove_talent_pool_member",
    title: "Remove Talent Pool Member",
    description:
      "Remove a candidate from a talent pool. Find candidate and pool ids with hrm_recruiting, then verify membership there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "poolId", description: "Talent pool id from hrm_recruiting." },
    bodySchema: removePoolMemberBody,
    payloadDescription: "Removal action with action: " + '"remove"' + " and candidateId.",
    destructive: true,
    href: recruitingHref,
    invoke: async (context, input, p) => {
      const b = p as { candidateId: string };
      await removePoolMember({
        ...actor(context),
        poolId: input.recordId!,
        candidateId: b.candidateId,
      });
      return { removed: b.candidateId };
    },
  }),
  talentCommand({
    name: "tag_talent_pool_candidate",
    title: "Tag Talent Pool Candidate",
    description:
      "Replace a candidate's tags in a talent pool. Find candidate and pool ids with hrm_recruiting, then verify the tags there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "poolId", description: "Talent pool id from hrm_recruiting." },
    bodySchema: tagCandidateBody,
    payloadDescription:
      "Tag action with action: " + '"tag"' + ", candidateId and the complete tag list.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      tags: await tagCandidate({ ...actor(context), poolId: input.recordId!, ...p } as never),
    }),
  }),
  talentCommand({
    name: "rediscover_talent_pool_candidates",
    title: "Rediscover Talent Pool Candidates",
    description:
      "Match talent-pool members against a requisition using its declared tags. Find the pool and requisition ids with hrm_recruiting and verify the matches there.",
    permission: READ,
    featureKey: FEATURE,
    recordId: { name: "poolId", description: "Talent pool id from hrm_recruiting." },
    bodySchema: rediscoverBody,
    payloadDescription: "Requisition id and its normalized matching tags.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      matches: await rediscoverForRequisition({
        ...actor(context),
        poolId: input.recordId!,
        ...p,
      } as never),
    }),
  }),
  talentCommand({
    name: "create_retention_rule",
    title: "Create Candidate Retention Rule",
    description:
      "Create an effective-dated candidate retention rule for a region and legal basis. Verify its policy with hrm_recruiting.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createRetentionRuleBody,
    payloadDescription:
      "Retention rule name, region scope, legal basis, retention months, action and consent-extension lead days.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      rule: await createRetentionRule({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "run_candidate_retention_rule",
    title: "Run Candidate Retention Rule",
    description:
      "Evaluate an existing candidate retention rule and persist the governed run. Find the rule id with hrm_recruiting and verify the run there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "ruleId", description: "Retention rule id from hrm_recruiting." },
    href: recruitingHref,
    invoke: async (context, input) => ({
      run: (await evaluateRetentionRule({
        ...actor(context),
        ruleId: input.recordId!,
      })) as unknown as Record<string, unknown>,
    }),
  }),
  talentCommand({
    name: "create_offer_template",
    title: "Create Offer Template",
    description:
      "Create a reusable offer document template with governed clauses. Verify it with hrm_recruiting.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createOfferTemplateBody,
    payloadDescription: "Offer template name, body template and structured clauses.",
    href: recruitingHref,
    invoke: async (context, _input, p) => ({
      template: await createOfferTemplate({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "render_offer_version",
    title: "Render Offer Version",
    description:
      "Render and persist an immutable offer version from approved terms and an offer template. Find offer/template ids with hrm_recruiting and verify the version there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "offerId", description: "Offer id from hrm_recruiting." },
    bodySchema: renderOfferVersionBody,
    payloadDescription: "Offer version inputs accepted by the native immutable version writer.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      version: await renderOfferVersion({
        ...actor(context),
        offerId: input.recordId!,
        ...p,
      } as never),
    }),
  }),
  talentCommand({
    name: "send_offer_signing_link",
    title: "Send Offer Signing Link",
    description:
      "Issue or send the candidate's signing link for an offer. Find the offer id with hrm_recruiting and provide the candidate email; verify signature status there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "offerId", description: "Offer id from hrm_recruiting." },
    bodySchema: offerSigningBody,
    payloadDescription:
      "Signing action and offer version id accepted by the native signing-link route.",
    href: recruitingHref,
    invoke: async (context, input, p) => ({
      link: await sendOfferLink({ ...actor(context), offerId: input.recordId!, ...p } as never),
    }),
  }),
  talentCommand({
    name: "void_offer_signature",
    title: "Void Offer Signature",
    description:
      "Void a pending offer signature link with the native reason and evidence. Find the offer id with hrm_recruiting and verify its signature history there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "offerId", description: "Offer id from hrm_recruiting." },
    bodySchema: offerSigningBody,
    payloadDescription: "Void action with action: " + '"void"' + " and the required reason.",
    destructive: true,
    href: recruitingHref,
    invoke: async (context, input, p) => {
      await voidOfferSignature({ ...actor(context), offerId: input.recordId!, ...p } as never);
      return { voided: input.recordId! };
    },
  }),
];

export const RECRUITING_READ_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_recruiting_candidate",
    title: "Get Recruiting Candidate",
    description:
      "Read a candidate's visible applications and interviews with the route's native PII redaction. Find the candidate id from a create command or a requisition application read, then use returned interview ids for scorecards and outcomes.",
    inputSchema: z.object({
      candidateId: z
        .string()
        .regex(UUID_RE)
        .describe("Candidate id from a recruiting command or application read."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => can(authz, READ),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, READ);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return {
          candidate: await getCandidateDetail({
            ...actor(context),
            candidateId: input.candidateId,
          }),
        };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  definition({
    name: "list_recruiting_postings",
    title: "List Recruiting Postings",
    description:
      "List job-board postings, optionally scoped to a requisition. Use hrm_recruiting for broader requisition and candidate search.",
    inputSchema: z.object({
      requisitionId: z
        .string()
        .regex(UUID_RE)
        .optional()
        .describe("Optional requisition id from hrm_recruiting."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => can(authz, READ),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, READ);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        const { listPostings } = await import("@openbooks/engine/hrm/recruiting/postings");
        return {
          ok: true,
          ...(await listPostings({ ...actor(context), requisitionId: input.requisitionId })),
        };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
];
