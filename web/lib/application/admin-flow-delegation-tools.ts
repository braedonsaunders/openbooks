import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  createDelegation,
  DelegationError,
  listUserDelegations,
  revokeDelegation,
} from "@openbooks/engine/flows/module";
import { delegateApprovalGateAction } from "@/app/api/flows/gates/delegate/route";
import { isFeatureEnabled } from "../features";
import { can } from "../authz";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { assertApplicationPermission, type ApplicationContext } from "./context";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("User or delegation id returned by list_approval_delegations.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

async function assertFlowsEnabled(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) throw notFound("route");
}

function assertApprovalAuthority(context: ApplicationContext) {
  const permission = can(context.authz, "flows.approve") ? "flows.approve" : "flows.manage";
  assertApplicationPermission(context, permission);
}

function settleDelegationError(error: unknown): never {
  if (error instanceof DelegationError) {
    const status = /not found/.test(error.message)
      ? 404
      : /already revoked|expired/.test(error.message)
        ? 409
        : 422;
    if (status === 404) throw new ApplicationError("not_found", error.message, 404);
    if (status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  throw error;
}

export const ADMIN_FLOW_DELEGATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_approval_delegations",
    title: "List Approval Delegations",
    description:
      "Read your active and upcoming approval delegations in both directions. Use this to find a delegation id before revoking it.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "flows.approve") || can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context) => {
      assertApprovalAuthority(context);
      await assertFlowsEnabled(context);
      return {
        delegations: await listUserDelegations(context.authz.user.orgId, context.authz.user.id),
        href: "/admin/flows",
      };
    },
  }),
  definition({
    name: "create_approval_delegation",
    title: "Create Approval Delegation",
    description:
      "Delegate your approval assignments to another active organization user for a bounded time window. Use list_users to find the user's id and list_approval_delegations to verify the saved delegation.",
    inputSchema: z.object({
      toUserId: UUID.describe("Active delegate user id returned by list_users."),
      startsAt: z
        .string()
        .max(35)
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
        .describe("Delegation start timestamp with timezone offset."),
      endsAt: z
        .string()
        .max(35)
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
        .describe("Delegation end timestamp with timezone offset."),
      reason: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Optional reason recorded with the delegation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.approve") || can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      assertApprovalAuthority(context);
      await assertFlowsEnabled(context);
      try {
        const result = await createDelegation({
          orgId: context.authz.user.orgId,
          fromUserId: context.authz.user.id,
          toUserId: input.toUserId,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          reason: input.reason,
        });
        return { ok: true, ...result, href: "/admin/flows" };
      } catch (error) {
        settleDelegationError(error);
      }
    },
  }),
  definition({
    name: "revoke_approval_delegation",
    title: "Revoke Approval Delegation",
    description:
      "Revoke one of your approval delegations. Use list_approval_delegations to find the id; the native service only lets the original delegator revoke it.",
    inputSchema: z.object({ id: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.approve") || can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      assertApprovalAuthority(context);
      await assertFlowsEnabled(context);
      try {
        await revokeDelegation(context.authz.user.orgId, input.id, context.authz.user.id);
        return { ok: true, delegationId: input.id, href: "/admin/flows" };
      } catch (error) {
        settleDelegationError(error);
      }
    },
  }),
  definition({
    name: "delegate_approval_gate",
    title: "Delegate Approval Gate",
    description:
      "Hand a pending approval gate to another active user in the organization. Use list_approvals to find the gate id and list_users to find the target; the route verifies assignee/admin authority and subsidiary scope.",
    inputSchema: z.object({
      gateId: UUID.describe("Pending approval gate id returned by list_approvals."),
      toUserId: UUID.describe("Active target user id returned by list_users."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.approve") || can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      assertApprovalAuthority(context);
      await assertFlowsEnabled(context);
      const response = await delegateApprovalGateAction({
        body: { gateId: input.gateId, toUserId: input.toUserId },
        authz: context.authz,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const message = typeof body.error === "string" ? body.error : "Approval delegation failed";
        if (response.status === 403) throw new ApplicationError("forbidden", message, 403, body);
        if (response.status === 404) throw new ApplicationError("not_found", message, 404, body);
        if (response.status === 409) throw conflict(message, body);
        throw invalidInput(message, body);
      }
      const body = (await response.json()) as Record<string, unknown>;
      return { ok: true, ...body, gateId: input.gateId, href: "/admin/flows" };
    },
  }),
];
