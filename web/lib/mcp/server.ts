import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerStaticResources,
  registerToolCatalog,
  type McpCatalogTool,
  type McpToolAuditEvent,
} from "@appkit/mcp";
import { logKeyEvent } from "../api-auth";
import {
  applicationContextFromApiKey,
  type ApplicationContext,
} from "../application/context";
import { listRecordTypes } from "../application/records";
import {
  APPLICATION_TOOLS,
  executeApplicationTool,
} from "../application/tool-catalog";
import { ASSISTANT_TOOLS, executeAssistantTool } from "../assistant/registry";
import { canRunTool } from "../assistant/gate";
import { AssistantToolFailure, mapMcpError, mcpErrorStatus } from "./errors";
import { MCP_SKILLS } from "./skills";
import type { OpenBooksMcpRequestContext } from "./types";

const VERSION = process.env.OPENBOOKS_VERSION || "development";

/**
 * Operating doctrine for any agent on this surface. The long-form playbooks
 * ship as readable resources (openbooks://skills/*) so the rules live on the
 * surface itself, not in client-side folklore.
 */
const INSTRUCTIONS = [
  "OpenBooks is an accounting system of record; you act as the authenticated user, never as the platform.",
  "Read before you write: fetch the records you are about to change and report the tool's own numbers, never recalled or estimated ones.",
  "Never invent identifiers, account codes, monetary amounts, periods, or approval decisions — resolve every reference through the find_* and list_* tools and use the stable UUIDs they return.",
  "Draft first: creating or updating a draft is routine; submitting, posting, voiding, or deciding an approval is a separate deliberate step subject to OpenBooks permissions, workflows, confirmations, period locks, and accounting controls.",
  "Every mutation requires a caller-generated idempotency key.",
  "Before multi-step work, read the playbook resources under openbooks://skills/ — start with the ground rules.",
].join(" ");

function auditHook(requestContext: OpenBooksMcpRequestContext) {
  return (event: McpToolAuditEvent): void => {
    logKeyEvent({
      orgId: requestContext.auth.user.orgId,
      keyId: requestContext.auth.keyId,
      method: "MCP",
      path: `/mcp/tools/${event.name}`,
      statusCode: event.status === "ok" ? 200 : event.statusCode ?? 500,
      durationMs: event.durationMs,
      req: requestContext.request,
      ...(event.errorSummary ? { error: event.errorSummary } : {}),
    });
  };
}

/** The canonical application catalog, adapted 1:1 onto the shared registrar. */
const applicationCatalog: readonly McpCatalogTool<ApplicationContext>[] =
  APPLICATION_TOOLS.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    readOnly: definition.readOnly,
    destructive: definition.destructive,
    openWorld: definition.openWorld,
    visible: (context) => definition.visibleTo(context.authz),
    execute: (context, input) => executeApplicationTool(definition, context, input),
  }));

/**
 * Assistant analysis tools on the same registrar. Failures are thrown as
 * AssistantToolFailure so both catalogs share one failure contract.
 */
const assistantCatalog: readonly McpCatalogTool<ApplicationContext>[] =
  ASSISTANT_TOOLS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    readOnly: definition.category !== "write",
    visible: (context) => canRunTool(context.authz, definition),
    summarize: (result) =>
      typeof result.note === "string" ? result.note : undefined,
    execute: async (context, input) => {
      const result = await executeAssistantTool(context.authz, definition.name, input);
      if (!result.ok) throw new AssistantToolFailure(result.error);
      return result as unknown as Record<string, unknown>;
    },
  }));

export function createOpenBooksMcpServer(
  requestContext: OpenBooksMcpRequestContext,
): McpServer {
  const context = applicationContextFromApiKey(
    requestContext.auth,
    "mcp",
    requestContext.requestId,
  );
  const server = new McpServer(
    { name: "openbooks", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  const options = {
    context,
    audit: auditHook(requestContext),
    mapError: mapMcpError,
    errorStatusCode: mcpErrorStatus,
  };
  registerToolCatalog(server, assistantCatalog, options);
  registerToolCatalog(server, applicationCatalog, options);

  registerStaticResources(server, [
    {
      name: "record-type-schema",
      uri: "openbooks://schema/record-types",
      title: "OpenBooks record-type schema",
      description:
        "Live tenant-specific record types and fields visible to the authenticated actor.",
      mimeType: "application/json",
      text: async () =>
        JSON.stringify({ recordTypes: await listRecordTypes(context) }),
    },
    ...MCP_SKILLS.map((skill) => ({
      name: `skill-${skill.slug}`,
      uri: `openbooks://skills/${skill.slug}`,
      title: skill.title,
      description: skill.description,
      text: skill.body,
    })),
  ]);

  return server;
}
