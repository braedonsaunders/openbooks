import "server-only";
import { z } from "zod";
import { can, type Authz } from "../authz";
import { APPLICATION_TOOLS } from "../application/tool-catalog";
import { FEATURES, featureEnabled, resolvedFeatureState } from "../features";
import { canRunTool } from "./gate";
import { matchTools, moduleOfTool } from "./tool-router";
import type { AssistantToolDef, ToolResult } from "./types";

/**
 * Capability discovery: what this user may actually call right now, read
 * from the live permission- and feature-bound catalog — the same gates that
 * build the model tool set — so "what can you do?" is never hallucinated.
 */

const MAX_BLURB_CHARS = 110;
/** Above this many visible tools the module overview lists names only; ask for one module to get blurbs. */
const BLURB_OVERVIEW_LIMIT = 40;

/** One line of description; never invents wording, only shortens. */
function oneLine(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  return text.length > MAX_BLURB_CHARS ? `${text.slice(0, MAX_BLURB_CHARS)}…` : text;
}

const describeCapabilities: AssistantToolDef = {
  name: "describe_capabilities",
  tier: "core",
  description:
    "Tools visible to this user, grouped by module, plus features currently off. Without `module`: names per module; pass one for blurbs. Call when asked what you can do; never list from memory. Read-only.",
  category: "read",
  // Which tools exist for the caller is not sensitive; every assistant user may ask.
  gate: { mode: "public" },
  inputSchema: z.object({
    module: z.string().max(40).optional().describe("Return only this module's tools, with descriptions (module keys come from the overview)"),
  }),
  execute: async (raw, authz: Authz): Promise<ToolResult> => {
    const { module: onlyModule } = raw as { module?: string };
    // Dynamic import: registry.ts mounts this file, so a static import would cycle.
    const { ASSISTANT_TOOLS, applicationToolVisible } = await import("./registry");
    const features = await resolvedFeatureState(authz.user.orgId);
    const visible = ASSISTANT_TOOLS.filter((tool) => canRunTool(authz, tool, features)).map((tool) => ({
      name: tool.name,
      blurb: oneLine(tool.description),
      module: tool.feature ?? "core",
    }));
    for (const definition of APPLICATION_TOOLS) {
      if (!applicationToolVisible(definition, authz, features)) continue;
      if (!definition.readOnly && !can(authz, "assistant.write")) continue;
      visible.push({
        name: definition.name,
        blurb: oneLine(definition.description),
        module: definition.featureKey ?? "core",
      });
    }
    const byModule = new Map<string, { name: string; blurb: string }[]>();
    for (const tool of visible) {
      const list = byModule.get(tool.module) ?? [];
      list.push({ name: tool.name, blurb: tool.blurb });
      byModule.set(tool.module, list);
    }
    // Keep the result inside the per-tool budget however large the catalog
    // grows: the overview carries names only once it is big, and blurbs are
    // served per module on request.
    const withBlurbs = onlyModule !== undefined || visible.length <= BLURB_OVERVIEW_LIMIT;
    const groups = [...byModule.entries()]
      .filter(([module]) => onlyModule === undefined || module === onlyModule)
      .map(([module, tools]) => ({
        module,
        count: tools.length,
        tools: tools
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((tool) => (withBlurbs ? tool : tool.name)),
      }))
      .sort((a, b) =>
        a.module === b.module ? 0 : a.module === "core" ? -1 : b.module === "core" ? 1 : (
          a.module < b.module ? -1 : 1
        ),
      );
    const featuresOff = FEATURES.filter((feature) => !featureEnabled(features, feature.key))
      .map((feature) => feature.key)
      .sort();
    if (onlyModule !== undefined && groups.length === 0) {
      return { ok: false, error: `unknown module; use one of: ${[...byModule.keys()].sort().join(", ")}` };
    }
    return {
      ok: true,
      data: { groups, featuresOff, totalTools: visible.length, detailed: withBlurbs },
      note: (withBlurbs ? "" : "Overview lists tool names per module; call again with `module` for descriptions. ") +
        "Live catalog for your permissions; tools of disabled modules are hidden. Mutating tools return a review card and change nothing until confirmed.",
    };
  },
};

const findToolsSchema = z.object({
  query: z.string().trim().min(1).max(200).optional()
    .describe("Keywords for the capability you need (e.g. inventory, pay run, tax return)"),
  module: z.string().max(40).optional()
    .describe("Return every tool in this module (module keys come from the empty call)"),
  limit: z.number().int().min(1).max(20).optional()
    .describe("Max tools to return for a query (default 8)"),
});

/** Live, gated catalog entries shaped for search: the same gates that build the model tool set. */
async function searchableCatalog(authz: Authz): Promise<{ name: string; blurb: string; module: string }[]> {
  // Dynamic imports: registry.ts mounts this file, so static imports would cycle.
  const { ASSISTANT_TOOLS, applicationToolVisible } = await import("./registry");
  const features = await resolvedFeatureState(authz.user.orgId);
  const catalog = ASSISTANT_TOOLS.filter((tool) => canRunTool(authz, tool, features)).map((tool) => ({
    name: tool.name,
    blurb: oneLine(tool.description),
    module: moduleOfTool(tool.name, tool.feature),
  }));
  for (const definition of APPLICATION_TOOLS) {
    if (!applicationToolVisible(definition, authz, features)) continue;
    if (!definition.readOnly && !can(authz, "assistant.write")) continue;
    catalog.push({
      name: definition.name,
      blurb: oneLine(definition.description),
      module: moduleOfTool(definition.name, definition.featureKey),
    });
  }
  return catalog;
}

const findTools: AssistantToolDef = {
  name: "find_tools",
  description:
    "Search assistant capabilities by keyword or module; returns matching tools with one-line blurbs and activates their modules for the rest of this turn. Call before saying a capability is missing. Read-only.",
  category: "search",
  tier: "core",
  // Which tools exist for the caller is not sensitive; every assistant user may ask.
  gate: { mode: "public" },
  inputSchema: findToolsSchema,
  execute: async (raw, authz: Authz): Promise<ToolResult> => {
    const parsed = findToolsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_input" };
    const { query, module: onlyModule, limit = 8 } = parsed.data;
    const catalog = await searchableCatalog(authz);
    if (onlyModule !== undefined) {
      const names = new Set(catalog.map((tool) => tool.module));
      if (!names.has(onlyModule)) {
        return { ok: false, error: `unknown module; use one of: ${[...names].sort().join(", ")}` };
      }
      const tools = catalog
        .filter((tool) => tool.module === onlyModule)
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .slice(0, 20);
      return {
        ok: true,
        data: { tools, modules: [onlyModule], total: tools.length },
        note: `Module ${onlyModule} is now active for the rest of this turn.`,
      };
    }
    if (query !== undefined) {
      const tools = matchTools(catalog, query, limit);
      const modules = [...new Set(tools.map((tool) => tool.module))].filter((m) => m !== "core").sort();
      return {
        ok: true,
        data: { tools, modules, total: tools.length },
        note: modules.length
          ? `Modules now active for the rest of this turn: ${modules.join(", ")}.`
          : "No new module matched; the core tools already cover this.",
      };
    }
    const counts = new Map<string, number>();
    for (const tool of catalog) counts.set(tool.module, (counts.get(tool.module) ?? 0) + 1);
    const modules = [...counts.entries()]
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => (a.module < b.module ? -1 : 1));
    return {
      ok: true,
      data: { tools: [], modules: modules.map((m) => m.module), counts: modules, total: catalog.length },
      note: "Module overview; call again with module or query for tool blurbs.",
    };
  },
};

export const META_TOOLS: AssistantToolDef[] = [describeCapabilities, findTools];
