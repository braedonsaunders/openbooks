import "server-only";
import { z } from "zod";
import { CONTINUOUS_CLOSE_AGENT_KEYS } from "@openbooks/engine/continuous-close/continuous-close";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { runSetupAgentAction } from "@/app/api/admin/setup/agents/[agentKey]/run/route";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const AGENT_KEYS = [...CONTINUOUS_CLOSE_AGENT_KEYS] as [string, ...string[]];
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

export const ADMIN_AGENT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "run_setup_agent",
    title: "Run Setup Agent",
    description:
      "Run a Continuous Close agent scan immediately. Use the agent key from the Setup Agents page; scans are organization-wide and require unrestricted subsidiary scope, then verify the result in the agent activity view.",
    inputSchema: z.object({
      agentKey: z.enum(AGENT_KEYS).describe("Continuous Close agent key shown in Setup Agents."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "continuousClose",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      if (!(await isFeatureEnabled(context.authz.user.orgId, "continuousClose")))
        throw notFound("route");
      const response = await runSetupAgentAction(
        new Request("https://openbooks.invalid/api/admin/setup/agents/run"),
        { params: Promise.resolve({ agentKey: input.agentKey }) },
        context.authz,
      );
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const message = typeof result.error === "string" ? result.error : "Setup agent run failed";
        if (response.status === 404) throw notFound(message);
        if (response.status === 409) throw conflict(message, result);
        if (response.status === 403) throw new ApplicationError("forbidden", message, 403, result);
        throw new ApplicationError("internal_error", message, response.status, result);
      }
      const result = (await response.json()) as Record<string, unknown>;
      return {
        ok: true,
        ...result,
        agentKey: input.agentKey,
        href: "/admin/setup/agents/activity",
      };
    },
  }),
];
