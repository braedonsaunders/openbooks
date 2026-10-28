import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { ApplicationError, notFound } from "./errors";
import { settleTalentRefusal, talentCommand, type TalentCommandInput } from "./talent-tools-shared";
import {
  courseBody,
  courseAction,
  sessionBody,
  sessionAction,
  invitationBody,
  responseBody,
  completionBody,
  voidBody,
  feedbackBody,
} from "@/app/api/hrm/training/contracts";
import {
  recordQualificationBody,
  attachEvidenceBody,
  verifyQualificationBody,
  renewQualificationBody,
  revokeQualificationBody,
  setRequirementBody,
} from "@/app/api/hrm/qualifications/bodies";
import {
  transitionTrainingCourse,
  createTrainingCourse,
  transitionTrainingSession,
  createTrainingSession,
  inviteTrainingParticipant,
  respondTrainingInvitation,
  completeTrainingParticipant,
  voidTrainingOutcome,
  recordTrainingFeedback,
  getTrainingCourse,
  getTrainingSession,
  getTrainingParticipant,
} from "@openbooks/engine/hrm/training";
import {
  attachEvidence,
  recordQualification,
  verifyQualification,
  renewQualification,
  revokeQualification,
} from "@openbooks/engine/hrm/qualifications/qualifications";
import { setAlertSchedule } from "@openbooks/engine/hrm/qualifications/types";
import {
  setRequirement,
  removeRequirement,
} from "@openbooks/engine/hrm/qualifications/requirements";
import { requireFileAccess } from "@/app/api/file-cabinet/lib";

const actor = (context: ApplicationContext) => ({
  orgId: context.authz.user.orgId,
  actorId: context.authz.user.id,
});
const TRAINING = "hrmTraining";
const CERTS = "hrmCertifications";
const MANAGE = "hrm.certifications.manage";
const href = "/hrm/training";
function trainingMutationHref(result: Record<string, unknown>, input: TalentCommandInput): string {
  const idOf = (value: unknown): string | undefined =>
    value && typeof value === "object" && "id" in value && typeof value.id === "string"
      ? value.id
      : undefined;
  if (input.recordName === "courseId" && input.recordId)
    return `${href}?course=${encodeURIComponent(input.recordId)}`;
  const courseId = idOf(result.course);
  if (courseId) return `${href}?course=${encodeURIComponent(courseId)}`;
  const session = result.session;
  if (session && typeof session === "object" && "courseId" in session) {
    const courseId = session.courseId;
    const sessionId = idOf(session) ?? input.recordId;
    if (typeof courseId === "string" && sessionId)
      return `${href}?course=${encodeURIComponent(courseId)}&childRow=${encodeURIComponent(sessionId)}`;
  }
  return href;
}
function qualificationMutationHref(
  result: Record<string, unknown>,
  input: TalentCommandInput,
): string {
  if (input.recordName === "requirementId") return "/hrm/qualifications?section=requirements";
  if (Array.isArray(input.payload?.leadDays)) return "/hrm/qualifications?section=alerts";
  const qualification = result.qualification;
  const id =
    (qualification &&
    typeof qualification === "object" &&
    "id" in qualification &&
    typeof qualification.id === "string"
      ? qualification.id
      : undefined) ?? input.recordId;
  if (id) return `/hrm/qualifications?qualification=${encodeURIComponent(id)}`;
  return "/hrm/qualifications?section=requirements";
}
export const TRAINING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  talentCommand({
    name: "create_training_course",
    title: "Create Training Course",
    description:
      "Create a draft training course with its employer, effective dates and completion policy. Find employer and qualification-type ids with setup reads, then verify the course with get_training_course.",
    permission: MANAGE,
    featureKey: TRAINING,
    bodySchema: courseBody,
    validationStatus: 422,
    payloadDescription:
      "Employer, code, version, name, exact effective dates, optional qualification type, attendance and passing thresholds, and reason.",
    href: trainingMutationHref,
    invoke: async (context, _input, p) => ({
      course: await createTrainingCourse({
        ...actor(context),
        ...p,
        id: randomUUID(),
      } as never),
    }),
  }),
  talentCommand({
    name: "create_training_session",
    title: "Create Training Session",
    description:
      "Create a draft session under an approved training course. Find the course id with get_training_course and verify the session with get_training_session before inviting employees.",
    permission: MANAGE,
    featureKey: TRAINING,
    recordId: {
      name: "courseId",
      description: "Approved training course id from get_training_course.",
    },
    bodySchema: sessionBody,
    validationStatus: 422,
    payloadDescription:
      "Session name, location, start and end timestamps, timezone, capacity, and reason.",
    href: trainingMutationHref,
    invoke: async (context, input, p) => ({
      session: await createTrainingSession({
        ...actor(context),
        ...p,
        courseId: input.recordId!,
        id: randomUUID(),
      } as never),
    }),
  }),
  ...(["submit", "retire", "cancel"] as const).map((action) =>
    talentCommand({
      name: `${action}_training_course`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Training Course`,
      description: `${action} a training course through its effective-dated policy lifecycle. Find the course id and revision with setup reads, then verify its state with the training course read.`,
      permission: MANAGE,
      featureKey: TRAINING,
      recordId: { name: "courseId", description: "Training course id from setup reads." },
      bodySchema: courseAction,
      payloadDescription: `Course action, expectedRevision, and reason; action must be "${action}".`,
      destructive: action !== "submit",
      href: trainingMutationHref,
      invoke: async (context, input, p) => ({
        course: await transitionTrainingCourse({
          courseId: input.recordId!,
          ...(p as Record<string, unknown>),
          ...actor(context),
        } as never),
      }),
    }),
  ),
  ...(["schedule", "start", "complete", "cancel"] as const).map((action) =>
    talentCommand({
      name: `${action}_training_session`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Training Session`,
      description: `${action} a training session and preserve its revisioned history. Find the session id and revision with setup reads, then verify the resulting state there.`,
      permission: MANAGE,
      featureKey: TRAINING,
      recordId: { name: "sessionId", description: "Training session id from setup reads." },
      bodySchema: sessionAction,
      payloadDescription: `Session action, expectedRevision, and reason; action must be "${action}".`,
      destructive: action === "cancel",
      href: trainingMutationHref,
      invoke: async (context, input, p) => ({
        session: await transitionTrainingSession({
          sessionId: input.recordId!,
          ...(p as Record<string, unknown>),
          ...actor(context),
        } as never),
      }),
    }),
  ),
  talentCommand({
    name: "invite_training_participant",
    title: "Invite Training Participant",
    description:
      "Assign an employee to a training session with its governed invitation. Find session and employment ids with setup and workforce reads; verify assignment status with the training participant read.",
    permission: MANAGE,
    featureKey: TRAINING,
    recordId: { name: "sessionId", description: "Training session id from setup reads." },
    bodySchema: invitationBody,
    validationStatus: 422,
    payloadDescription: "Employment id and required invitation reason.",
    href: trainingMutationHref,
    invoke: async (context, input, p) => ({
      participant: await inviteTrainingParticipant({
        sessionId: input.recordId!,
        ...(p as Record<string, unknown>),
        id: randomUUID(),
        ...actor(context),
      } as never),
    }),
  }),
  ...(["accept", "decline", "cancel"] as const).map((action) =>
    talentCommand({
      name: `${action}_training_invitation`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Training Invitation`,
      description: `${action} an assigned training invitation as the staff actor. Find the participant id and revision with the training participant read, then verify its state there.`,
      permission: MANAGE,
      featureKey: TRAINING,
      recordId: {
        name: "participantId",
        description: "Training participant id from the native participant read.",
      },
      bodySchema: responseBody,
      payloadDescription: `Invitation action, expectedRevision, and reason; action must be "${action}".`,
      destructive: action === "cancel" || action === "decline",
      href: trainingMutationHref,
      invoke: async (context, input, p) => ({
        participant: await respondTrainingInvitation({
          participantId: input.recordId!,
          ...(p as Record<string, unknown>),
          ...actor(context),
          audience: "staff",
        } as never),
      }),
    }),
  ),
  talentCommand({
    name: "complete_training_participant",
    title: "Complete Training Participant",
    description:
      "Record attendance, score, evidence and any qualification produced by a training session. Find the participant, evidence-file and qualification ids with native reads, then verify completion and qualification history.",
    permission: MANAGE,
    featureKey: TRAINING,
    recordId: {
      name: "participantId",
      description: "Training participant id from the native participant read.",
    },
    bodySchema: completionBody,
    validationStatus: 422,
    payloadDescription:
      "Expected revision, attendance seconds, optional score, evidence file and existing qualification ids, notes and reason.",
    href: trainingMutationHref,
    invoke: async (context, input, p) => {
      const body = p as { evidenceFileId?: string | null; [key: string]: unknown };
      if (body.evidenceFileId) {
        const denied = await requireFileAccess(context.authz, body.evidenceFileId, "viewer");
        if (denied) {
          const message =
            "The certificate is unavailable in your File Cabinet scope — select a readable certificate or ask its owner to grant access before recording this result.";
          throw new ApplicationError(
            denied.status === 403 ? "forbidden" : "not_found",
            message,
            denied.status,
          );
        }
      }
      return {
        participant: await completeTrainingParticipant({
          participantId: input.recordId!,
          ...body,
          ...actor(context),
        } as never),
      };
    },
  }),
  talentCommand({
    name: "void_training_outcome",
    title: "Void Training Outcome",
    description:
      "Void a recorded training outcome with its revision and reason; the audit history remains. Find the participant id with the training participant read and verify the voided status there.",
    permission: MANAGE,
    featureKey: TRAINING,
    recordId: {
      name: "participantId",
      description: "Training participant id from the native participant read.",
    },
    bodySchema: voidBody,
    validationStatus: 422,
    payloadDescription: "Expected revision and required reason for the outcome void.",
    destructive: true,
    href: trainingMutationHref,
    invoke: async (context, input, p) => ({
      participant: await voidTrainingOutcome({
        participantId: input.recordId!,
        ...(p as Record<string, unknown>),
        ...actor(context),
      } as never),
    }),
  }),
  talentCommand({
    name: "record_training_feedback",
    title: "Record Training Feedback",
    description:
      "Record feedback for a completed training participant, preserving revision and supersession history. Find the participant id and current revision with the training participant read.",
    permission: MANAGE,
    featureKey: TRAINING,
    recordId: {
      name: "participantId",
      description: "Training participant id from the native participant read.",
    },
    bodySchema: feedbackBody,
    validationStatus: 422,
    payloadDescription: "Rating, optional comments, optional superseded feedback id and reason.",
    href: trainingMutationHref,
    invoke: async (context, input, p) => ({
      feedback: await recordTrainingFeedback({
        participantId: input.recordId!,
        ...(p as Record<string, unknown>),
        id: randomUUID(),
        ...actor(context),
        audience: "staff",
      } as never),
    }),
  }),
];

export const TRAINING_READ_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_training_course",
    title: "Get Training Course",
    description:
      "Read a course and its sessions through the native training scope. Find course ids with setup reads before assigning or scheduling training.",
    inputSchema: z.object({
      courseId: z.string().regex(UUID_RE).describe("Course id from setup reads."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: TRAINING,
    visibleTo: (authz) => can(authz, "hrm.certifications.read"),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, "hrm.certifications.read");
        if (!(await isFeatureEnabled(context.authz.user.orgId, TRAINING))) throw notFound(TRAINING);
        return getTrainingCourse({ ...actor(context), courseId: input.courseId });
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  definition({
    name: "get_training_session",
    title: "Get Training Session",
    description:
      "Read a training session, its state and its participants. Find session ids with setup reads or get_training_course before inviting staff or changing its lifecycle.",
    inputSchema: z.object({
      sessionId: z
        .string()
        .regex(UUID_RE)
        .describe("Session id from setup reads or get_training_course."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: TRAINING,
    visibleTo: (authz) => can(authz, "hrm.certifications.read"),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, "hrm.certifications.read");
        if (!(await isFeatureEnabled(context.authz.user.orgId, TRAINING))) throw notFound(TRAINING);
        return getTrainingSession({ ...actor(context), sessionId: input.sessionId });
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  definition({
    name: "get_training_participant",
    title: "Get Training Participant",
    description:
      "Read a training assignment, current revision and recorded completion. Find participant ids with get_training_session before responding or recording results.",
    inputSchema: z.object({
      participantId: z
        .string()
        .regex(UUID_RE)
        .describe("Participant id from get_training_session."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: TRAINING,
    visibleTo: (authz) => can(authz, "hrm.certifications.read"),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, "hrm.certifications.read");
        if (!(await isFeatureEnabled(context.authz.user.orgId, TRAINING))) throw notFound(TRAINING);
        return getTrainingParticipant({
          ...actor(context),
          participantId: input.participantId,
          audience: "staff",
        });
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
];

const scheduleBody = z.object({
  leadDays: z
    .array(z.number().int().positive())
    .min(1)
    .max(12)
    .describe("Expiry alert lead days; positive whole days."),
});

export const QUALIFICATION_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  talentCommand({
    name: "attach_qualification_evidence",
    title: "Attach Qualification Evidence",
    description:
      "Attach an already uploaded file to a qualification without verifying it. Find the qualification and file ids with hrm_qualifications and verify the evidence trail there; either HR certification readers or the holder may attach to their own pending record.",
    permission: null,
    permissionAnyOf: ["hrm.certifications.read", "hrm.self.read"],
    featureKey: CERTS,
    recordId: { name: "qualificationId", description: "Qualification id from hrm_qualifications." },
    bodySchema: attachEvidenceBody,
    payloadDescription: "File id of evidence already uploaded through the File Cabinet.",
    href: qualificationMutationHref,
    invoke: async (context, input, p) => ({
      qualification: await withOrgTransaction(context.authz.user.orgId, () =>
        attachEvidence(db, {
          ...actor(context),
          qualificationId: input.recordId!,
          ...(p as Record<string, unknown>),
        } as never),
      ),
    }),
  }),
  talentCommand({
    name: "record_qualification",
    title: "Record Qualification",
    description:
      "Record a worker qualification or certification with an effective date and evidence. Find employment, type and evidence-file ids with hrm_qualifications, then verify the ledger record there.",
    permission: "hrm.certifications.manage",
    featureKey: CERTS,
    bodySchema: recordQualificationBody,
    payloadDescription:
      "Employment id, qualification type id, issue date, optional expiry, identifier, evidence file and notes.",
    href: qualificationMutationHref,
    invoke: async (context, _input, p) => ({
      qualification: await withOrgTransaction(context.authz.user.orgId, () =>
        recordQualification(db, { ...actor(context), ...p } as never),
      ),
    }),
  }),
  talentCommand({
    name: "verify_qualification",
    title: "Verify Qualification",
    description:
      "Verify a pending qualification after checking its evidence. Find the qualification id with hrm_qualifications and verify the resulting status and event history there.",
    permission: "hrm.certifications.manage",
    featureKey: CERTS,
    recordId: { name: "qualificationId", description: "Qualification id from hrm_qualifications." },
    bodySchema: verifyQualificationBody,
    payloadDescription: "Optional verification reason.",
    href: qualificationMutationHref,
    invoke: async (context, input, p) => ({
      qualification: await withOrgTransaction(context.authz.user.orgId, () =>
        verifyQualification(db, {
          ...actor(context),
          qualificationId: input.recordId!,
          ...p,
        } as never),
      ),
    }),
  }),
  talentCommand({
    name: "renew_qualification",
    title: "Renew Qualification",
    description:
      "Renew a qualification by writing a new linked record; the prior record stays immutable. Find the prior qualification and evidence ids with hrm_qualifications, then verify both records there.",
    permission: "hrm.certifications.manage",
    featureKey: CERTS,
    recordId: {
      name: "qualificationId",
      description: "Prior qualification id from hrm_qualifications.",
    },
    bodySchema: renewQualificationBody,
    payloadDescription: "New issue date and optional expiry, evidence file, identifier and notes.",
    href: qualificationMutationHref,
    invoke: async (context, input, p) => ({
      qualification: await withOrgTransaction(context.authz.user.orgId, () =>
        renewQualification(db, {
          ...actor(context),
          qualificationId: input.recordId!,
          ...p,
        } as never),
      ),
    }),
  }),
  talentCommand({
    name: "revoke_qualification",
    title: "Revoke Qualification",
    description:
      "Revoke a qualification with a recorded reason; its history remains immutable. Find the qualification id with hrm_qualifications and verify its status and event history there.",
    permission: "hrm.certifications.manage",
    featureKey: CERTS,
    recordId: { name: "qualificationId", description: "Qualification id from hrm_qualifications." },
    bodySchema: revokeQualificationBody,
    payloadDescription: "Required reason for revoking the qualification.",
    destructive: true,
    href: qualificationMutationHref,
    invoke: async (context, input, p) => ({
      qualification: await withOrgTransaction(context.authz.user.orgId, () =>
        revokeQualification(db, {
          ...actor(context),
          qualificationId: input.recordId!,
          ...p,
        } as never),
      ),
    }),
  }),
  talentCommand({
    name: "set_qualification_requirement",
    title: "Set Qualification Requirement",
    description:
      "Set an effective-dated qualification requirement for a project, equipment, position or classification. Find subject and qualification-type ids with HRM reads, then verify it in qualification requirements.",
    permission: "hrm.certifications.manage",
    featureKey: CERTS,
    bodySchema: setRequirementBody,
    payloadDescription:
      "Subject kind/id, qualification type id, effective date range and block or warn severity.",
    href: qualificationMutationHref,
    invoke: async (context, _input, p) => ({
      requirement: await withOrgTransaction(context.authz.user.orgId, () =>
        setRequirement(db, { ...actor(context), ...p } as never),
      ),
    }),
  }),
  talentCommand({
    name: "remove_qualification_requirement",
    title: "Remove Qualification Requirement",
    description:
      "Remove an existing qualification requirement; the native service refuses unknown or out-of-scope rows. Find its id with the qualification requirements read and verify the removal there.",
    permission: "hrm.certifications.manage",
    featureKey: CERTS,
    recordId: {
      name: "requirementId",
      description: "Requirement id from the qualification requirements read.",
    },
    destructive: true,
    href: qualificationMutationHref,
    invoke: async (context, input) => {
      await withOrgTransaction(context.authz.user.orgId, () =>
        removeRequirement(db, { ...actor(context), requirementId: input.recordId! }),
      );
      return { ok: true };
    },
  }),
  talentCommand({
    name: "set_qualification_alert_schedule",
    title: "Set Qualification Alert Schedule",
    description:
      "Set the organization-wide expiry alert lead days. This policy affects every legal entity and requires unrestricted subsidiary scope; verify the effective schedule in qualification settings.",
    permission: "hrm.certifications.manage",
    featureKey: CERTS,
    unrestrictedScope: true,
    bodySchema: scheduleBody,
    payloadDescription:
      "The complete positive whole-day leadDays array for qualification expiry alerts.",
    href: qualificationMutationHref,
    invoke: async (context, _input, p) => ({
      settings: (await setAlertSchedule(db, {
        ...actor(context),
        ...p,
      } as never)) as unknown as Record<string, unknown>,
    }),
  }),
];
