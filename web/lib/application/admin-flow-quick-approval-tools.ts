import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import {
  createQuickApprovalFlowAction,
  requestBodySchema,
} from "@/app/api/admin/flows/quick-approval/route";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const quickApprovalSchema = requestBodySchema
  .omit({ threshold: true, subjectKind: true })
  .extend({
    subjectKind: z
      .string()
      .min(1)
      .max(100)
      .refine(
        (value) => requestBodySchema.shape.subjectKind.safeParse(value).success,
        "subject kind is not supported",
      )
      .describe("Subject kind for the approval flow."),
  })
  .extend({ idempotencyKey: IDEMPOTENCY_KEY });

function requestFor(context: ApplicationContext): Request {
  return new Request("https://openbooks.invalid/api/admin/flows/quick-approval", {
    headers: { "X-Request-Id": context.requestId },
  });
}

async function requireFlowAdmin(context: ApplicationContext): Promise<void> {
  assertApplicationPermission(context, "flows.manage");
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "flows"))) throw notFound("route");
}

export const ADMIN_FLOW_QUICK_APPROVAL_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_quick_approval_flow",
    title: "Create Quick Approval Flow",
    description:
      "Create an enabled approval flow for every submission of one subject kind, assigned to a user or role. Use list_admin_flows to verify it; this shortcut creates an all-amount policy without a monetary threshold.",
    inputSchema: quickApprovalSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "flows.manage"),
    featureKey: "flows",
    execute: async (context, input) => {
      await requireFlowAdmin(context);
      const { idempotencyKey: _key, ...body } = input;
      const parsedBody = requestBodySchema.safeParse(body);
      if (!parsedBody.success)
        throw invalidInput("invalid quick approval flow request", {
          issues: parsedBody.error.issues,
        });
      const response = await createQuickApprovalFlowAction({
        request: requestFor(context),
        body: parsedBody.data,
        authz: context.authz,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const message =
          typeof payload.error === "string" ? payload.error : "Quick approval flow was not created";
        if (response.status === 403)
          throw new ApplicationError("forbidden", message, response.status, payload);
        if (response.status === 404) throw notFound(message);
        throw invalidInput(message, payload);
      }
      const result = (await response.json()) as Record<string, unknown>;
      const id = typeof result.id === "string" ? result.id : "";
      return {
        ok: true,
        ...result,
        status: "enabled",
        href: id ? `/admin/flows/${id}` : "/admin/flows",
      };
    },
  }),
];
