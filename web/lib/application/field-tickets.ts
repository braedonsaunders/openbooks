import "server-only";
import { isFeatureEnabled } from "../features";
import {
  createFieldTicket,
  FieldTicketError,
  FieldTicketNotFoundError,
  TICKET_PERIODS,
  type TicketPeriod,
} from "../field-tickets";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

/** Draft field ticket — same writer as POST /api/field-tickets. */
export async function createApplicationFieldTicket(
  context: ApplicationContext,
  input: { projectId: string; date?: string; period?: string; idempotencyKey: string },
): Promise<{ replayed: boolean; result: { id: string; documentNumber: string } }> {
  assertApplicationPermission(context, "time.manage");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "fieldTickets"))) throw notFound("field ticket");
  if (!isUuid(input.projectId)) throw invalidInput("projectId required");
  if (input.period !== undefined && !TICKET_PERIODS.includes(input.period as TicketPeriod)) {
    throw invalidInput("Invalid ticket period");
  }
  const outcome = await executeIdempotent({
    context,
    operation: "field_ticket.create",
    idempotencyKey: input.idempotencyKey,
    request: { projectId: input.projectId, date: input.date ?? null, period: input.period ?? null },
    execute: async () => {
      try {
        return await createFieldTicket(context.authz.user.orgId, context.authz.user.id, {
          projectId: input.projectId,
          date: input.date,
          period: input.period as TicketPeriod | undefined,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
      } catch (error) {
        if (error instanceof FieldTicketNotFoundError) throw notFound("project");
        if (error instanceof FieldTicketError) throw new ApplicationError("invalid_input", error.message, 422);
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}
