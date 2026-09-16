import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerStaticResources,
  registerToolCatalog,
  type McpCatalogTool,
  type McpToolAuditEvent,
} from "@braedonsaunders/appkit-mcp";
import {
  insertApiKeyEvent,
  takeClaimedCommandEvidence,
  transportEvent,
} from "../application/api-key-audit";
import {
  applicationContextFromApiKey,
  type ApplicationContext,
} from "../application/context";
import { listRecordTypes } from "../application/records";
import {
  APPLICATION_TOOLS,
  executeApplicationTool,
} from "../application/tool-catalog";
import { ASSISTANT_TOOLS, applicationToolVisible, executeAssistantTool } from "../assistant/registry";
import { listAppToolViews, runAppTool, toAssistantToolDef } from "../apps/tools";
import { can } from "../authz";
import { resolvedFeatureState } from "../features";
import type { FeatureState } from "@openbooks/engine/src/feature-registry.ts";
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
  return async (event: McpToolAuditEvent): Promise<void> => {
    // A mutating tool's fresh execution already committed its durable evidence
    // inside its own idempotency claim transaction (via context.requestAudit);
    // the consumed marker suppresses a duplicate row. Everything else — read
    // tools, replays, failures — is evidenced here. The registrar awaits this
    // hook before returning the tool result, so the event is durable before a
    // response can escape. A persistence failure is intentionally propagated
    // and fails the request closed rather than returning unaudited evidence.
    if (!takeClaimedCommandEvidence(requestContext.auth.audit)) {
      await insertApiKeyEvent(transportEvent(
        requestContext.auth.audit,
        { orgId: requestContext.auth.user.orgId, keyId: requestContext.auth.keyId },
        {
          statusCode: event.status === "ok" ? 200 : event.statusCode ?? 500,
          ...(event.errorSummary ? { error: event.errorSummary } : {}),
        },
        { method: "MCP", path: `/mcp/tools/${event.name}` },
      ));
    }
  };
}

/** The canonical application catalog, adapted 1:1 onto the shared registrar.
 *  Built per request so visibility can honour the org's feature state. */
const applicationCatalog = (features: FeatureState): readonly McpCatalogTool<ApplicationContext>[] =>
  APPLICATION_TOOLS.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    readOnly: definition.readOnly,
    destructive: definition.destructive,
    openWorld: definition.openWorld,
    visible: (context) => applicationToolVisible(definition, context.authz, features),
    execute: (context, input) => executeApplicationTool(definition, context, input),
  }));

/**
 * Assistant analysis tools on the same registrar. Failures are thrown as
 * AssistantToolFailure so both catalogs share one failure contract.
 */
const assistantCatalog = (features: FeatureState): readonly McpCatalogTool<ApplicationContext>[] =>
  ASSISTANT_TOOLS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    readOnly: definition.category !== "write",
    visible: (context) => canRunTool(context.authz, definition, features),
    summarize: (result) =>
      typeof result.note === "string" ? result.note : undefined,
    execute: async (context, input) => {
      const result = await executeAssistantTool(context.authz, definition.name, input, features);
      if (!result.ok) throw new AssistantToolFailure(result.error);
      return result as unknown as Record<string, unknown>;
    },
  }));

/**
 * Installed apps' declared tools on the same registrar. Visibility equals the
 * chat registry for the same actor and feature state; like the application
 * catalog, the API-key surface executes directly (the confirmation card is a
 * chat concept — chat mutating app tools still propose first).
 */
const appCatalog = async (
  context: ApplicationContext,
  features: FeatureState,
): Promise<readonly McpCatalogTool<ApplicationContext>[]> => {
  const staticNames = new Set([
    ...ASSISTANT_TOOLS.map((definition) => definition.name),
    ...APPLICATION_TOOLS.map((definition) => definition.name),
  ]);
  const views = await listAppToolViews(context.authz.user.orgId, context.authz, features);
  return views
    .filter((view) => !staticNames.has(view.name))
    .map((view) => {
      const definition = toAssistantToolDef(view);
      return {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        readOnly: definition.category !== "write",
        visible: (candidate) => canRunTool(candidate.authz, definition, features),
        summarize: (result) =>
          typeof result.note === "string" ? result.note : undefined,
        execute: async (candidate, input) => {
          const outcome = await runAppTool({
            orgId: candidate.authz.user.orgId,
            user: candidate.authz.user,
            appKey: view.appKey,
            toolKey: view.toolKey,
            input,
            userCan: (perm) => can(candidate.authz, perm),
            allowedSubsidiaryIds: candidate.authz.allowedSubsidiaryIds,
          });
          if (!outcome.ok) throw new AssistantToolFailure(outcome.error);
          return { ok: true, data: outcome.result } as unknown as Record<string, unknown>;
        },
      };
    });
};

export async function createOpenBooksMcpServer(
  requestContext: OpenBooksMcpRequestContext,
): Promise<McpServer> {
  const context = applicationContextFromApiKey(
    requestContext.auth,
    "mcp",
    requestContext.requestId,
  );
  // One feature-state read per request: tools of disabled modules are not
  // registered at all, so an MCP client sees the same catalog the chat sees.
  const features = await resolvedFeatureState(context.authz.user.orgId);
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
  registerToolCatalog(server, assistantCatalog(features), options);
  registerToolCatalog(server, applicationCatalog(features), options);
  registerToolCatalog(server, await appCatalog(context, features), options);

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
