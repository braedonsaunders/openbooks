import { featureEnabled, type FeatureState } from "@openbooks/engine/src/feature-registry.ts";
import { can, type Authz } from "../authz";
import type { AssistantToolDef, PermissionRule } from "./types";

// Permission gating for assistant tools. The model is
// only ever handed tools the current user may run; execute() re-checks the
// same gate defensively. A tool bound to an optional feature is additionally
// hidden while the org has that feature off.

function passesGate(authz: Authz, gate: PermissionRule): boolean {
  switch (gate.mode) {
    case "public":
      return true;
    case "anyOf":
      return gate.perms.some((p) => can(authz, p));
    case "allOf":
      return gate.perms.every((p) => can(authz, p));
  }
}

/** True when the tool's optional feature (if any) is on for the org. When no
 *  feature state is supplied the feature check is skipped — callers that own
 *  a turn resolve the state once and pass it. */
export function toolFeatureEnabled(tool: AssistantToolDef, features: FeatureState | null | undefined): boolean {
  if (!tool.feature || !features) return true;
  return featureEnabled(features, tool.feature);
}

/** A tool is runnable iff the user holds assistant.use, plus assistant.write
 *  for write tools, plus the tool's own gate, plus its feature being on. */
export function canRunTool(authz: Authz, tool: AssistantToolDef, features?: FeatureState | null): boolean {
  if (!can(authz, "assistant.use")) return false;
  if (tool.category === "write" && !can(authz, "assistant.write")) return false;
  if (!toolFeatureEnabled(tool, features)) return false;
  return passesGate(authz, tool.gate);
}
