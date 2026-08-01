import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { mcpFailure, mcpSuccess } from "./result";
import type { OpenBooksMcpRequestContext } from "./types";

const VERSION = process.env.OPENBOOKS_VERSION || "development";
const INSTRUCTIONS = [
  "OpenBooks is an accounting system of record.",
  "Read before writing; use stable UUIDs returned by tools.",
  "Never infer monetary amounts, accounts, subsidiaries, periods, or approval decisions.",
  "Every mutation requires a caller-generated idempotency key.",
  "Consequential actions remain subject to OpenBooks permissions, workflows, confirmations, period locks, and accounting controls.",
].join(" ");

function title(name: string): string {
  return name
    .split("_")
    .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function toolAudit(
  requestContext: OpenBooksMcpRequestContext,
  name: string,
  startedAt: number,
  statusCode: number,
  error?: string,
): void {
  logKeyEvent({
    orgId: requestContext.auth.user.orgId,
    keyId: requestContext.auth.keyId,
    method: "MCP",
    path: `/mcp/tools/${name}`,
    statusCode,
    durationMs: Date.now() - startedAt,
    req: requestContext.request,
    error,
  });
}

async function runTool(
  requestContext: OpenBooksMcpRequestContext,
  name: string,
  execute: () => Promise<ReturnType<typeof mcpSuccess>>,
) {
  const startedAt = Date.now();
  try {
    const result = await execute();
    toolAudit(requestContext, name, startedAt, 200);
    return result;
  } catch (error) {
    const result = mcpFailure(error);
    const code = error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status) || 500
      : 500;
    toolAudit(requestContext, name, startedAt, code, result.content[0]?.type === "text"
      ? result.content[0].text.slice(0, 500)
      : "tool failed");
    return result;
  }
}

function registerAssistantTools(
  server: McpServer,
  requestContext: OpenBooksMcpRequestContext,
  context: ApplicationContext,
): void {
  for (const definition of ASSISTANT_TOOLS) {
    if (!canRunTool(context.authz, definition)) continue;
    server.registerTool(
      definition.name,
      {
        title: title(definition.name),
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => runTool(requestContext, definition.name, async () => {
        const result = await executeAssistantTool(context.authz, definition.name, args);
        if (!result.ok) {
          return {
            isError: true,
            structuredContent: result,
            content: [{ type: "text" as const, text: result.error }],
          };
        }
        return mcpSuccess(result, result.note);
      }),
    );
  }
}

function registerApplicationTools(
  server: McpServer,
  requestContext: OpenBooksMcpRequestContext,
  context: ApplicationContext,
): void {
  for (const definition of APPLICATION_TOOLS) {
    if (!definition.visibleTo(context.authz)) continue;
    server.registerTool(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: definition.destructive,
        openWorldHint: definition.openWorld,
      },
    }, async (input) => runTool(requestContext, definition.name, async () =>
      mcpSuccess(await executeApplicationTool(definition, context, input))));
  }
}

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

  registerAssistantTools(server, requestContext, context);
  registerApplicationTools(server, requestContext, context);

  server.registerResource(
    "record-type-schema",
    "openbooks://schema/record-types",
    {
      title: "OpenBooks record-type schema",
      description: "Live tenant-specific record types and fields visible to the authenticated actor.",
      mimeType: "application/json",
    },
    async () => {
      const recordTypes = await listRecordTypes(context);
      return {
        contents: [{
          uri: "openbooks://schema/record-types",
          mimeType: "application/json",
          text: JSON.stringify({ recordTypes }),
        }],
      };
    },
  );

  return server;
}
