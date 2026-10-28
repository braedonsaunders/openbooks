import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  reissueInvitationToken,
  listOwnInvitations,
  submitResponse,
} from "@openbooks/engine/hrm/surveys/responses";
import {
  closeSurvey,
  getSurvey,
  listSurveys,
  saveSurvey,
} from "@openbooks/engine/hrm/surveys/surveys";
import { openSurveyBody, saveSurveyBody, submitAnswersBody } from "@/app/api/hrm/surveys/bodies";
import type { ApplicationContext } from "./context";
import { invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { settleTalentRefusal, talentCommand, type TalentCommandInput } from "./talent-tools-shared";
import { openSurveyAndDeliver } from "../hrm/survey-actions";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission } from "./context";

const FEATURE = "hrmSurveys";
const MANAGE = "hrm.surveys.manage";
const SELF_READ = "hrm.self.read";
const actor = (context: ApplicationContext) => ({
  orgId: context.authz.user.orgId,
  actorId: context.authz.user.id,
});
const href = "/hrm/surveys";
function surveyMutationHref(result: Record<string, unknown>, input: TalentCommandInput): string {
  if (input.recordName === "invitationId") return "/me/surveys";
  const survey = result.survey;
  const id =
    input.recordId ??
    (survey && typeof survey === "object" && "id" in survey && typeof survey.id === "string"
      ? survey.id
      : undefined);
  return id ? `${href}?survey=${encodeURIComponent(id)}` : href;
}

function surveyAppBaseUrl(context: ApplicationContext): string {
  const env = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  const configured = context.appBaseUrl?.trim().replace(/\/+$/, "");
  const baseUrl = env || configured;
  if (!baseUrl) {
    throw invalidInput(
      "Survey invitations require OPENBOOKS_APP_URL or an authenticated application origin.",
    );
  }
  return baseUrl;
}

export const SURVEY_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_surveys",
    title: "List Surveys",
    description:
      "List authored surveys and their lifecycle state. Use this to find survey ids before opening, closing or checking aggregate results.",
    inputSchema: z.object({
      status: z.string().max(32).optional().describe("Optional survey lifecycle status filter."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => can(authz, MANAGE),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, MANAGE);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return { surveys: await listSurveys({ ...actor(context), status: input.status }) };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  definition({
    name: "get_survey",
    title: "Get Survey",
    description:
      "Read an authored survey with its lifecycle state and questions. Find the survey id with list_surveys and use this before opening or closing it.",
    inputSchema: z.object({
      surveyId: z.string().regex(UUID_RE).describe("Survey id from list_surveys."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => can(authz, MANAGE),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, MANAGE);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return { survey: await getSurvey({ ...actor(context), surveyId: input.surveyId }) };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  talentCommand({
    name: "save_survey",
    title: "Save Survey",
    description:
      "Create a survey or update a draft survey's questions, audience, schedule and anonymity. Find an existing survey id with list_surveys, then verify its saved definition with get_survey.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: saveSurveyBody,
    payloadDescription:
      "Survey name, kind, anonymity, one or more typed questions, optional surveyId, opening/closing timestamps, audience, recurrence and minimum group size.",
    href: surveyMutationHref,
    invoke: async (context, _input, p) => ({
      survey: await saveSurvey({
        ...actor(context),
        surveyId: p.surveyId as string | undefined,
        name: p.name as string,
        kind: p.kind as never,
        anonymity: p.anonymity as never,
        opensAt: (p.opensAt as string | null | undefined) ?? null,
        closesAt: (p.closesAt as string | null | undefined) ?? null,
        audience: (p.audience as Record<string, unknown> | undefined) ?? {},
        recurrence: (p.recurrence as Record<string, unknown> | null | undefined) ?? null,
        minGroupSize: p.minGroupSize as number | undefined,
        questions: p.questions as never,
      }),
    }),
  }),
  talentCommand({
    name: "open_survey",
    title: "Open Survey",
    description:
      "Open a saved survey and deliver its invitations to the selected parties. Find survey and party ids with list_surveys and native HRM people reads; verify delivery and lifecycle status with get_survey.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "surveyId", description: "Survey id from list_surveys." },
    bodySchema: openSurveyBody,
    payloadDescription: "partyIds: the complete invited party list for this survey launch.",
    openWorld: true,
    href: surveyMutationHref,
    invoke: async (context, input, p) =>
      openSurveyAndDeliver({
        ...actor(context),
        surveyId: input.recordId!,
        partyIds: p.partyIds as string[],
        appBaseUrl: surveyAppBaseUrl(context),
      }),
  }),
  talentCommand({
    name: "close_survey",
    title: "Close Survey",
    description:
      "Close a live survey and freeze further responses. Find its id and open state with list_surveys or get_survey, then verify the closed result with hrm_survey_results.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "surveyId", description: "Survey id from list_surveys." },
    payloadDescription: "No request fields are required; pass an empty object.",
    destructive: true,
    href: surveyMutationHref,
    invoke: async (context, input) => ({
      survey: await closeSurvey({ ...actor(context), surveyId: input.recordId! }),
    }),
  }),
  talentCommand({
    name: "reissue_own_survey_invitation",
    title: "Reissue Own Survey Invitation",
    description:
      "Re-mint a response link only for the caller's own open survey invitation. Find invitation ids with list_own_survey_invitations; the old token becomes invalid.",
    permission: SELF_READ,
    featureKey: FEATURE,
    recordId: {
      name: "invitationId",
      description: "Own survey invitation id from list_own_survey_invitations.",
    },
    payloadDescription: "No request fields are required; pass an empty object.",
    href: surveyMutationHref,
    invoke: async (context, input) => ({
      ...(await reissueInvitationToken({ ...actor(context), invitationId: input.recordId! })),
    }),
  }),
  talentCommand({
    name: "respond_to_own_survey",
    title: "Respond to Own Survey",
    description:
      "Submit the caller's own response to an open survey invitation; the service verifies the invitation belongs to the signed-in user and consumes it once. Find the invitation id with list_own_survey_invitations.",
    permission: SELF_READ,
    featureKey: FEATURE,
    recordId: {
      name: "invitationId",
      description: "Own survey invitation id from list_own_survey_invitations.",
    },
    bodySchema: submitAnswersBody,
    payloadDescription:
      "Answer array with each questionId and the native typed value for that question.",
    href: surveyMutationHref,
    invoke: async (context, input, p) => {
      const invitation = await reissueInvitationToken({
        ...actor(context),
        invitationId: input.recordId!,
      });
      const today = await businessToday(context.authz.user.orgId);
      return submitResponse({ token: invitation.token, answers: p.answers as never, today });
    },
  }),
  definition({
    name: "list_own_survey_invitations",
    title: "List Own Survey Invitations",
    description:
      "List open survey invitations belonging to the signed-in user, without exposing another respondent's identity or link token. Use the invitation id with respond_to_own_survey.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => can(authz, SELF_READ),
    execute: async (context) => {
      try {
        assertApplicationPermission(context, SELF_READ);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return { invitations: await listOwnInvitations(actor(context)), href: "/me/surveys" };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
];
