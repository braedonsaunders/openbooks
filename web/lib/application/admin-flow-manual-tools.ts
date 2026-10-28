import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { withOrgContext } from "@openbooks/engine/platform/db";
import { retryFlowRunAction } from "@/app/api/flows/runs/[id]/retry/route";
import { withdrawApprovalCommand } from "@openbooks/engine/flows/command-approval";
import { FlowDispatchError } from "@openbooks/engine/flows/dispatch-result";
import { approvalRequestHref } from "@openbooks/engine/flows";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { availableButtons, runManualFlowAction } from "@/app/api/flows/manual/route";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("Record id returned by the corresponding record read tool.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

async function assertFlowsEnabled(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) throw notFound("route");
}

function assertFlowOperationAuthority(context: ApplicationContext) {
  const permission = can(context.authz, "flows.approve") ? "flows.approve" : "flows.manage";
  assertApplicationPermission(context, permission);
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  if (response.ok) return (await response.json()) as Record<string, unknown>;
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof body.error === "string" ? body.error : "Flow action failed";
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, body);
  if (response.status === 404) throw new ApplicationError("not_found", message, 404, body);
  if (response.status === 409) throw conflict(message, body);
  throw invalidInput(message, body);
}

export const ADMIN_FLOW_MANUAL_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_manual_flow_actions",
    title: "List Available Manual Flow Actions",
    description:
      "List the manual workflow buttons currently available to the caller on one record. Use the record read tool to find its id, then use a returned button id with run_manual_flow_action.",
    inputSchema: z.object({
      subjectKind: z.string().trim().min(1).max(100).describe("Native record kind."),
      subjectId: UUID,
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "flows.approve") || can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      assertFlowOperationAuthority(context);
      await assertFlowsEnabled(context);
      const result = await withOrgContext(context.authz.user.orgId, () =>
        availableButtons(context.authz, input.subjectKind, input.subjectId),
      );
      if (result instanceof Response) {
        return { ...(await parseResponse(result)), href: "/admin/flows" };
      }
      return { buttons: result, href: "/admin/flows" };
    },
  }),
  definition({
    name: "run_manual_flow_action",
    title: "Run Manual Flow Action",
    description:
      "Run one manual flow button on its record. Use list_manual_flow_actions to obtain the button id; the route rechecks current availability and subject permissions immediately before dispatch.",
    inputSchema: z.object({
      subjectKind: z.string().trim().min(1).max(100).describe("Native record kind."),
      subjectId: UUID,
      buttonId: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .describe("Button id from list_manual_flow_actions."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.approve") || can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      assertFlowOperationAuthority(context);
      await assertFlowsEnabled(context);
      const { idempotencyKey: _key, ...body } = input;
      const response = await runManualFlowAction({ body, authz: context.authz });
      return { ok: true, ...(await parseResponse(response)), href: "/admin/flows" };
    },
  }),
  definition({
    name: "retry_flow_run",
    title: "Retry Flow Run",
    description:
      "Retry one failed flow run after its cause is fixed. Use get_admin_flow to find the run id; the route rechecks its subject's subsidiary scope and executes against the current flow definition.",
    inputSchema: z.object({
      runId: UUID.describe("Failed flow run id returned by get_admin_flow."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      await assertFlowsEnabled(context);
      const response = await retryFlowRunAction(
        new Request("https://openbooks.invalid/api/flows/runs/retry"),
        { params: Promise.resolve({ id: input.runId }) },
        context.authz,
      );
      return {
        ok: true,
        ...(await parseResponse(response)),
        runId: input.runId,
        href: "/admin/flows",
      };
    },
  }),
  definition({
    name: "withdraw_approval_command",
    title: "Withdraw Approval Command",
    description:
      "Withdraw a pending native approval submission with an audited reason. Use list_approvals to find the subject id and kind; this governed recall remains available even while new flows are disabled.",
    inputSchema: z.object({
      subjectKind: z.string().trim().min(1).max(100).describe("Native approval subject kind."),
      subjectId: UUID.describe("Subject id returned by list_approvals."),
      reason: z
        .string()
        .trim()
        .min(3)
        .max(2000)
        .describe("Reason recorded for recalling the pending submission."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.approve") || can(authz, "flows.manage"),
    execute: async (context, input) => {
      assertFlowOperationAuthority(context);
      try {
        await withdrawApprovalCommand({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof FlowDispatchError) throw invalidInput(error.message);
        throw error;
      }
      return {
        ok: true,
        subjectId: input.subjectId,
        href: approvalRequestHref(input.subjectKind, input.subjectId),
      };
    },
  }),
];
