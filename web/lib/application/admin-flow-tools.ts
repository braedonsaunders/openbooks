import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import {
  createAdminFlowAction,
  readAdminFlowsAction,
  requestBodySchema as createFlowBody,
} from "@/app/api/admin/flows/route";
import {
  deleteAdminFlowAction,
  readAdminFlowAction,
  updateAdminFlowAction,
} from "@/app/api/admin/flows/[id]/route";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("Flow id returned by list_admin_flows.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function requestFor(context: ApplicationContext): Request {
  return new Request("https://openbooks.invalid/api/admin/flows", {
    headers: {
      "X-Request-Id": context.requestId,
      "user-agent": `OpenBooks ${context.source} command`,
    },
  });
}

async function assertFlowsEnabled(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) throw notFound("route");
}

async function requireFlowAdmin(context: ApplicationContext) {
  assertApplicationPermission(context, "flows.manage");
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
  await assertFlowsEnabled(context);
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  if (response.ok) return (await response.json()) as Record<string, unknown>;
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof payload.error === "string" ? payload.error : "Flow operation failed";
  if (response.status === 403)
    throw new ApplicationError("forbidden", message, 403, { permission: "flows.manage" });
  if (response.status === 404) throw notFound(message);
  if (response.status === 409) throw conflict(message, payload);
  throw invalidInput(message, payload);
}

const createFlowSchema = z.object({
  name: createFlowBody.shape.name,
  subjectKind: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(
      (value) => createFlowBody.shape.subjectKind.safeParse(value).success,
      "subject kind is not supported",
    )
    .describe("Subject type this flow governs."),
  boardId: createFlowBody.shape.boardId,
  schedulePreset: createFlowBody.shape.schedulePreset,
  idempotencyKey: IDEMPOTENCY_KEY,
});
const updateFlowSchema = z
  .object({
    id: UUID,
    expectedUpdatedAt: z
      .string()
      .min(1)
      .max(64)
      .describe("Exact flow revision returned by get_admin_flow."),
    name: z.string().max(200).optional().describe("Replacement flow name."),
    description: z.string().max(2000).optional().describe("Replacement flow description."),
    graph: z
      .json()
      .optional()
      .describe("New flow graph definition; the native route validates the graph before saving."),
    enabled: z.boolean().optional().describe("Whether the flow is published and active."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.graph !== undefined ||
      input.enabled !== undefined,
    "provide a flow field to update",
  );

export const ADMIN_FLOW_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_admin_flows",
    title: "List Administration Flows",
    description:
      "List workflow definitions and scope-safe run summaries. Use this to find flow ids and current revisions before editing or publishing a flow.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context) => {
      assertApplicationPermission(context, "flows.manage");
      await assertFlowsEnabled(context);
      return {
        ...(await readPayload(await readAdminFlowsAction(context.authz))),
        href: "/admin/flows",
      };
    },
  }),
  definition({
    name: "get_admin_flow",
    title: "Get Administration Flow",
    description:
      "Read one flow graph and its in-scope recent runs. Use list_admin_flows to find the flow id, then use the returned revision when updating it.",
    inputSchema: z.object({ id: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      assertApplicationPermission(context, "flows.manage");
      await assertFlowsEnabled(context);
      const response = await readAdminFlowAction(
        requestFor(context),
        { params: Promise.resolve({ id: input.id }) },
        context.authz,
      );
      return { ...(await readPayload(response)), href: `/admin/flows/${input.id}` };
    },
  }),
  definition({
    name: "create_flow",
    title: "Create Flow",
    description:
      "Create a flow for an available subject type; the native handler validates subject features and creates a valid initial graph. Use list_admin_flows to verify the new definition.",
    inputSchema: createFlowSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      requireFlowAdmin(context);
      const { idempotencyKey: _idempotencyKey, ...body } = input;
      const parsedBody = createFlowBody.safeParse(body);
      if (!parsedBody.success)
        throw invalidInput("invalid flow creation request", { issues: parsedBody.error.issues });
      const response = await createAdminFlowAction({
        request: requestFor(context),
        body: parsedBody.data,
        authz: context.authz,
      });
      const payload = await readPayload(response);
      const id = String(payload.id ?? "");
      return { ok: true, ...payload, href: id ? `/admin/flows/${id}` : "/admin/flows" };
    },
  }),
  definition({
    name: "update_flow_definition",
    title: "Update Flow Definition",
    description:
      "Save a flow graph revision, metadata, or enabled state using the exact revision from get_admin_flow. The route validates graph structure, reports authoring lints, and enforces flow subject features and scope.",
    inputSchema: updateFlowSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      requireFlowAdmin(context);
      const { idempotencyKey: _idempotencyKey, id, ...body } = input;
      const response = await updateAdminFlowAction({
        request: requestFor(context),
        params: { id },
        body,
        authz: context.authz,
      });
      return { ok: true, ...(await readPayload(response)), flowId: id, href: `/admin/flows/${id}` };
    },
  }),
  definition({
    name: "publish_flow",
    title: "Publish Flow",
    description:
      "Enable a validated flow using the exact revision from get_admin_flow. Use update_flow_definition to edit the definition first; verify the enabled state with get_admin_flow.",
    inputSchema: z.object({
      id: UUID,
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(64)
        .describe("Exact flow revision returned by get_admin_flow."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      requireFlowAdmin(context);
      const response = await updateAdminFlowAction({
        request: requestFor(context),
        params: { id: input.id },
        body: { expectedUpdatedAt: input.expectedUpdatedAt, enabled: true },
        authz: context.authz,
      });
      return {
        ok: true,
        ...(await readPayload(response)),
        flowId: input.id,
        status: "enabled",
        href: `/admin/flows/${input.id}`,
      };
    },
  }),
  definition({
    name: "delete_admin_flow",
    title: "Delete Administration Flow",
    description:
      "Delete an unused flow definition with no run or approval history. Use get_admin_flow for its current revision; flows with history must be disabled so their audit trail stays intact.",
    inputSchema: z.object({
      id: UUID,
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(64)
        .describe("Exact flow revision returned by get_admin_flow."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      requireFlowAdmin(context);
      const response = await deleteAdminFlowAction({
        request: requestFor(context),
        params: { id: input.id },
        body: { expectedUpdatedAt: input.expectedUpdatedAt },
        authz: context.authz,
      });
      return {
        ok: true,
        ...(await readPayload(response)),
        flowId: input.id,
        status: "deleted",
        href: "/admin/flows",
      };
    },
  }),
];
