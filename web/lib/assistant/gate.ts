import { can, type Authz } from "../authz";
import type { AssistantToolDef, PermissionRule } from "./types";

// Permission gating for assistant tools, ported from beaconhs. The model is
// only ever handed tools the current user may run; execute() re-checks the
// same gate defensively.

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

/** A tool is runnable iff the user holds assistant.use, plus assistant.write
 *  for write tools, plus the tool's own gate. */
export function canRunTool(authz: Authz, tool: AssistantToolDef): boolean {
  if (!can(authz, "assistant.use")) return false;
  if (tool.category === "write" && !can(authz, "assistant.write")) return false;
  return passesGate(authz, tool.gate);
}
