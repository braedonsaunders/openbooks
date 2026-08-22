import "server-only";
import {
  decideGate,
  GateError,
  worklistGates,
} from "@openbooks/engine/src/flows/index.ts";
import { isFeatureEnabled } from "../features";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

export async function listApprovalWorklist(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) return [];
  assertApplicationPermission(context, "flows.approve");
  const gates = await worklistGates(
    context.authz.user.orgId,
    context.authz.user.id,
    context.authz.user.roles.map((role) => role.key),
  );
  const allowed = context.authz.allowedSubsidiaryIds;
  return allowed === null
    ? gates
    : gates.filter((gate) => !gate.document || !gate.document.subsidiaryId || allowed.has(gate.document.subsidiaryId));
}

export async function decideApproval(
  context: ApplicationContext,
  input: {
    gateId: string;
    decision: "approved" | "rejected";
    comment?: string;
    signature?: string;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) throw notFound("approval");
  assertApplicationPermission(context, "flows.approve");
  if (!isUuid(input.gateId)) throw invalidInput("gateId must be a UUID");
  if (input.decision === "rejected" && !input.comment?.trim()) {
    throw invalidInput("a rejection comment is required");
  }
  const visible = await listApprovalWorklist(context);
  const gate = visible.find((candidate) => candidate.id === input.gateId);
  if (!gate) throw notFound("approval");
  if (gate.signatureRequired && input.decision === "approved" && !input.signature?.trim()) {
    throw invalidInput("this approval requires the actor's explicit signature");
  }
  const outcome = await executeIdempotent({
    context,
    operation: "approvals.decide",
    idempotencyKey: input.idempotencyKey,
    request: {
      gateId: input.gateId,
      decision: input.decision,
      comment: input.comment ?? null,
      signature: input.signature ?? null,
    },
    execute: async () => {
      try {
        return await decideGate({
          gateId: input.gateId,
          decision: input.decision,
          userId: context.authz.user.id,
          comment: input.comment,
          signature: input.signature,
        });
      } catch (error) {
        if (error instanceof GateError) {
          throw new ApplicationError("invalid_input", error.message, 422);
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}
