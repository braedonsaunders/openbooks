import "server-only";
import { openSurvey } from "@openbooks/engine/hrm/surveys/surveys";
import { deliverSurveyInvitations } from "./document-delivery";

/** Open a survey and deliver its invitations through the same audited route workflow. */
export async function openSurveyAndDeliver(input: {
  orgId: string;
  actorId: string;
  surveyId: string;
  partyIds: string[];
  appBaseUrl: string;
}) {
  const { survey, deliveries } = await openSurvey(input);
  const results = await deliverSurveyInvitations({
    orgId: input.orgId,
    actorId: input.actorId,
    appBaseUrl: input.appBaseUrl,
    surveyName: survey.name,
    anonymity: survey.anonymity,
    closesDate: survey.closesAt ?? undefined,
    recipients: deliveries,
  });
  return {
    survey,
    deliveries: deliveries.map((delivery) => {
      const result = results.find((row) => row.partyId === delivery.partyId);
      return {
        invitationId: delivery.invitationId,
        partyId: delivery.partyId,
        respondUrl: `${input.appBaseUrl.replace(/\/$/, "")}/survey/${delivery.token}`,
        notified: result?.notified ?? false,
        emailed: result?.emailed ?? false,
        emailSkippedReason: result?.emailSkippedReason ?? null,
      };
    }),
  };
}
