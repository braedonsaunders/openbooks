import "server-only";
import { z } from "zod";
import { AIDisabledError } from "../assistant/client";
import { generateBriefing, loadBriefing, sendBriefingEmail } from "../agents/briefing";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

async function requireBriefing(context: ApplicationContext): Promise<void> {
  assertApplicationPermission(context, "assistant.use");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "continuousClose")))
    throw notFound("route");
}

function settleBriefingError(error: unknown): never {
  if (error instanceof AIDisabledError)
    throw new ApplicationError("internal_error", "ai_not_configured", 503);
  if (error instanceof Error && error.message === "briefing_empty")
    throw new ApplicationError("internal_error", "briefing_empty", 502);
  throw error;
}

export const ADMIN_BRIEFING_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_agent_briefing",
    title: "Get Agent Briefing",
    description:
      "Read today's role-shaped Continuous Close briefing, if one has been generated. Use this before generating or emailing the current briefing.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "assistant.use"),
    featureKey: "continuousClose",
    execute: async (context) => {
      await requireBriefing(context);
      return { ...(await loadBriefing(context.authz)), href: "/agents/briefing" };
    },
  }),
  definition({
    name: "generate_agent_briefing",
    title: "Generate Agent Briefing",
    description:
      "Generate and save today's role-shaped Continuous Close briefing using read-only business tools. The briefing must not be available already; use get_agent_briefing to verify it afterward.",
    inputSchema: z.object({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "assistant.use"),
    featureKey: "continuousClose",
    execute: async (context) => {
      await requireBriefing(context);
      try {
        const briefing = await generateBriefing(context.authz);
        return { ok: true, briefing, href: "/agents/briefing" };
      } catch (error) {
        settleBriefingError(error);
      }
    },
  }),
  definition({
    name: "send_agent_briefing_email",
    title: "Send Agent Briefing Email",
    description:
      "Email today's saved Continuous Close briefing to the calling user. Generate it first when get_agent_briefing returns no briefing; use that read to verify the current copy.",
    inputSchema: z.object({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "assistant.use"),
    featureKey: "continuousClose",
    execute: async (context) => {
      await requireBriefing(context);
      const { briefing } = await loadBriefing(context.authz);
      if (!briefing) throw conflict("Generate today's briefing before emailing it.");
      const result = await sendBriefingEmail(context.authz, briefing.text);
      return { ok: true, ...result, href: "/agents/briefing" };
    },
  }),
];
