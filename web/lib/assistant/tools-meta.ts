import "server-only";
import { z } from "zod";
import { can, type Authz } from "../authz";
import { APPLICATION_TOOLS } from "../application/tool-catalog";
import { FEATURES, featureEnabled, resolvedFeatureState } from "../features";
import { canRunTool } from "./gate";
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
    "What this user can do right now: every assistant and application tool visible to them, grouped by module, plus the optional features currently off. Without `module` it returns the overview (tool names per module, with one-line blurbs only when the catalog is small); pass `module` (e.g. core, projects, payroll, apps) for that module's tools with descriptions. Call this when the user asks what you can do instead of listing capabilities from memory. Read-only.",
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

export const META_TOOLS: AssistantToolDef[] = [describeCapabilities];
