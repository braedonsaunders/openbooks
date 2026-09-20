import "server-only";
import { randomUUID } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { featureEnabled, type FeatureState } from "@openbooks/engine/src/organization/feature-registry.ts";
import type { Authz } from "../authz";
import { can, ForbiddenError } from "../authz";
import { applicationContextFromSession } from "../application/context";
import {
  APPLICATION_TOOLS,
  executeApplicationTool,
} from "../application/tool-catalog";
import { canRunTool } from "./gate";
import {
  activateTurnModules,
  createTurnScope,
  findToolsModules,
  moduleOfTool,
  preRouteModules,
  resolveActiveToolNames,
  type TurnScope,
} from "./tool-router";
import { listAppToolViews, toAssistantToolDef } from "../apps/tools";
import { signApplicationCommand } from "./application-proposals";
import { READ_TOOLS } from "./tools";
import { ANALYTICS_TOOLS } from "./tools-analytics";
import { BANKING_TOOLS } from "./tools-banking";
import { ADMIN_TOOLS } from "./tools-admin";
import { BUDGET_TOOLS } from "./tools-budgets";
import { CLOSE_TOOLS } from "./tools-close";
import { CONSTRUCTION_TOOLS } from "./tools-construction";
import { CRM_TOOLS } from "./tools-crm";
import { SUBSCRIPTION_TOOLS } from "./tools-subscriptions";
import { PROPERTY_TOOLS } from "./tools-property";
import { TIME_TOOLS } from "./tools-time";
import { EXPENSE_TOOLS } from "./tools-expenses";
import { FX_TOOLS } from "./tools-fx";
import { PROJECT_TOOLS } from "./tools-projects";
import { TAX_TOOLS } from "./tools-tax";
import { FILE_TOOLS } from "./tools-files";
import { OPS_TOOLS } from "./tools-ops";
import { INVENTORY_TOOLS } from "./tools-inventory";
import { ORDERS_TOOLS } from "./tools-orders";
import { ASSETS_TOOLS } from "./tools-assets";
import { EQUIPMENT_TOOLS } from "./tools-equipment";
import { SUBCONTRACTS_TOOLS } from "./tools-subcontracts";
import { PAYROLL_TOOLS } from "./tools-payroll";
import { HRM_TOOLS } from "./tools-hrm";
import { REPORTING_TOOLS } from "./tools-reports";
import { SETUP_TOOLS } from "./tools-setup";
import { META_TOOLS } from "./tools-meta";
import { WRITE_TOOLS } from "./tools-write";
import { ALLOCATIONS_TOOLS } from "./tools-allocations";
import type { AssistantToolDef, ToolResult, ToolTier } from "./types";
import { safeApplicationToolError } from "./tool-errors";

/**
 * Builds the per-turn AI-SDK ToolSet. The model only
 * ever SEES tools the current user may run (first gate); every execute()
 * re-checks the gate (second gate); write tools add a third gate at commit
 * time in /api/assistant/commit.
 */

export const ASSISTANT_TOOLS: readonly AssistantToolDef[] = [
  ...READ_TOOLS,
  ...ADMIN_TOOLS,
  ...BUDGET_TOOLS,
  ...PROJECT_TOOLS,
  ...TAX_TOOLS,
  ...CONSTRUCTION_TOOLS,
  ...CRM_TOOLS,
  ...SUBSCRIPTION_TOOLS,
  ...PROPERTY_TOOLS,
  ...TIME_TOOLS,
  ...EXPENSE_TOOLS,
  ...ANALYTICS_TOOLS,
  ...REPORTING_TOOLS,
  ...BANKING_TOOLS,
  ...CLOSE_TOOLS,
  ...FX_TOOLS,
  ...PAYROLL_TOOLS,
  ...HRM_TOOLS,
  ...FILE_TOOLS,
  ...OPS_TOOLS,
  ...INVENTORY_TOOLS,
  ...ORDERS_TOOLS,
  ...ASSETS_TOOLS,
  ...EQUIPMENT_TOOLS,
  ...SUBCONTRACTS_TOOLS,
  ...SETUP_TOOLS,
  ...META_TOOLS,
  ...ALLOCATIONS_TOOLS,
  ...WRITE_TOOLS,
];

function safeErrorMessage(e: unknown): string {
  // Only controlled application feedback may reach the model, never raw exceptions.
  if (e instanceof ForbiddenError) return "forbidden";
  return safeApplicationToolError(e);
}

/** An application tool is visible when the actor may see it AND its optional
 *  feature (if declared) is on for the org. */
export function applicationToolVisible(
  definition: { visibleTo: (authz: Authz) => boolean; featureKey?: string },
  authz: Authz,
  features?: FeatureState | null,
): boolean {
  if (definition.featureKey && features && !featureEnabled(features, definition.featureKey)) return false;
  return definition.visibleTo(authz);
}

/** Execute one named tool through the same gates and error contract as AI SDK calls. */
export async function executeAssistantTool(
  authz: Authz,
  name: string,
  args: unknown,
  features?: FeatureState | null,
): Promise<ToolResult> {
  const definition = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
  if (definition) {
    if (!canRunTool(authz, definition, features)) return { ok: false, error: "forbidden" };
    try {
      return await definition.execute(args, authz);
    } catch (error) {
      console.warn(`[assistant] tool ${name} failed`, error);
      return { ok: false, error: safeErrorMessage(error) };
    }
  }
  // App-declared tools (app_<appKey>_<toolKey>) resolve per request against
  // the installed manifests and run through the same gated path as the
  // registry entries the chat turn was built with.
  if (name.startsWith("app_")) {
    const views = await listAppToolViews(authz.user.orgId, authz, features);
    const view = views.find((v) => v.name === name);
    if (!view) return { ok: false, error: "forbidden" };
    const appDefinition = toAssistantToolDef(view);
    if (!canRunTool(authz, appDefinition, features)) return { ok: false, error: "forbidden" };
    try {
      return await appDefinition.execute(args, authz);
    } catch (error) {
      console.warn(`[assistant] tool ${name} failed`, error);
      return { ok: false, error: safeErrorMessage(error) };
    }
  }
  return { ok: false, error: "forbidden" };
}

/** Async turn registry: the static catalog plus the installed apps' declared
 *  tools for this actor, appended after the static entries. A colliding app
 *  tool name is skipped — installs reject collisions, so a skip only fires
 *  for an app installed before a built-in tool took its name, and the
 *  built-in keeps the slot. */
export async function buildToolRegistryAsync(
  authz: Authz,
  features?: FeatureState | null,
  hooks?: ChatToolHooks,
): Promise<ToolSet> {
  const base = buildToolRegistry(authz, features, hooks);
  if (features && !featureEnabled(features, "apps")) return base;
  const taken = new Set(Object.keys(base));
  const views = await listAppToolViews(authz.user.orgId, authz, features);
  for (const view of views) {
    if (taken.has(view.name)) continue;
    const def = toAssistantToolDef(view);
    if (!canRunTool(authz, def, features)) continue;
    const execute = (args: unknown): Promise<ToolResult> => executeAssistantTool(authz, def.name, args, features);
    taken.add(def.name);
    (base as Record<string, ToolSet[string]>)[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute,
    });
  }
  return base;
}

/**
 * Chat-loop hooks. The MCP surface and background agents pass none, so
 * find_tools there is plain catalog search; the chat turn passes
 * onActivateModules to grow the sent tool set for the rest of the turn.
 */
export type ChatToolHooks = {
  onActivateModules?: (modules: string[]) => void;
};

/** Construct the permission- and feature-bound tool set the model may use this
 *  turn. `features` is the org's resolved feature state (resolve it once per
 *  turn with resolvedFeatureState); tools of disabled features are omitted. */
export function buildToolRegistry(authz: Authz, features?: FeatureState | null, hooks?: ChatToolHooks): ToolSet {
  const runnable = ASSISTANT_TOOLS.filter((t) => canRunTool(authz, t, features));
  const entries = runnable.map((t) => {
    // Shared execute wrapper: defensive gate re-check + never-throw contract.
    const base = (args: unknown): Promise<ToolResult> => executeAssistantTool(authz, t.name, args, features);
    // find_tools both answers and activates: a successful search grows the
    // turn's sent tool set through the hook (no-op when no hook is passed).
    const onActivate = hooks?.onActivateModules;
    const execute = t.name === "find_tools" && onActivate
      ? async (args: unknown): Promise<ToolResult> => {
        const result = await base(args);
        const modules = findToolsModules(result);
        if (modules.length > 0) onActivate(modules);
        return result;
      }
      : base;
    return [
      t.name,
      tool({ description: t.description, inputSchema: t.inputSchema, execute }),
    ] as const;
  });
  const applicationEntries = APPLICATION_TOOLS
    .filter((definition) =>
      applicationToolVisible(definition, authz, features)
      && (definition.readOnly || can(authz, "assistant.write")))
    .map((definition) => {
      const execute = async (input: unknown): Promise<ToolResult> => {
        try {
          const parsed = definition.inputSchema.parse(input);
          if (definition.assistantConfirmation === "always") {
            return {
              ok: true,
              data: {
                proposedApplicationCommand: {
                  toolName: definition.name,
                  title: definition.title,
                  destructive: definition.destructive,
                  input: parsed,
                  confirmToken: signApplicationCommand(definition.name, parsed, authz),
                },
              },
              note: "Awaiting explicit user confirmation. Nothing has been changed.",
            };
          }
          const context = applicationContextFromSession(
            authz,
            "assistant",
            `assistant:${randomUUID()}`,
          );
          return { ok: true, data: await executeApplicationTool(definition, context, parsed) };
        } catch (error) {
          console.warn(`[assistant] application tool ${definition.name} failed`, error);
          return { ok: false, error: safeErrorMessage(error) };
        }
      };
      return [
        definition.name,
        tool({ description: definition.description, inputSchema: definition.inputSchema, execute }),
      ] as const;
    });
  return Object.fromEntries([...entries, ...applicationEntries]);
}

/** Feature flag (if any) behind one catalog tool, for module resolution. */
function featureOfTool(name: string): string | undefined {
  const assistant = ASSISTANT_TOOLS.find((t) => t.name === name);
  if (assistant) return assistant.feature;
  return APPLICATION_TOOLS.find((t) => t.name === name)?.featureKey;
}

export type ChatCatalogEntry = { name: string; tier: ToolTier; module: string };

let cachedChatCatalog: ChatCatalogEntry[] | null = null;

/** Static tier/module snapshot of the full catalog. Visibility always comes
 *  from the built ToolSet — the SDK ignores activeTools names it was never
 *  registered with, so over-naming here is safe and under-naming impossible
 *  for static tools. */
export function chatCatalogTiers(): ChatCatalogEntry[] {
  cachedChatCatalog ??= [
    ...ASSISTANT_TOOLS.map((t) => ({
      name: t.name,
      tier: t.tier ?? "module",
      module: moduleOfTool(t.name, t.feature),
    })),
    ...APPLICATION_TOOLS.map((t) => ({
      name: t.name,
      tier: t.tier ?? "module",
      module: moduleOfTool(t.name, t.featureKey),
    })),
  ];
  return cachedChatCatalog;
}

export type ChatTurn = {
  /** Full visible catalog (registration — activation stays instant and typed). */
  tools: ToolSet;
  /** Per-turn activation state, threaded through prepareStep. */
  scope: TurnScope;
  /** Tool names the model may see this step: core ∪ pre-routed ∪ activated,
   *  plus installed app tools (dynamic, outside the static snapshot). */
  activeTools: () => string[];
};

/** Assemble one chat turn: pre-route from the user message + conversation,
 *  register the full gated catalog, and serve the per-step active subset. */
export async function buildChatTurn(
  authz: Authz,
  features: FeatureState | null | undefined,
  message: string,
  priorNames: readonly string[] = [],
): Promise<ChatTurn> {
  const scope = createTurnScope(
    preRouteModules(message, priorNames, (name) => moduleOfTool(name, featureOfTool(name))),
  );
  const tools = await buildToolRegistryAsync(authz, features, {
    onActivateModules: (modules) => activateTurnModules(scope, modules),
  });
  const staticNames = new Set(chatCatalogTiers().map((t) => t.name));
  const dynamicNames = Object.keys(tools).filter((name) => !staticNames.has(name));
  return {
    tools,
    scope,
    activeTools: () => [...resolveActiveToolNames(chatCatalogTiers(), scope), ...dynamicNames],
  };
}

/** Per-step gate: the final step must answer, and every step only sends the
 *  turn's active tools (verified: the SDK filters the request payload by
 *  activeTools). Without the resolver every registered tool is sent —
 *  the background-agent behaviour, unchanged. The narrow parameter keeps
 *  the step policy unit-testable without a model. */
export function createChatPrepareStep(
  maxSteps: number,
  activeTools?: () => string[],
): (options: { stepNumber: number }) => { toolChoice?: "none"; activeTools?: string[] } {
  return ({ stepNumber }) => ({
    ...(stepNumber >= maxSteps - 1 ? { toolChoice: "none" as const } : undefined),
    ...(activeTools ? { activeTools: activeTools() } : undefined),
  });
}
