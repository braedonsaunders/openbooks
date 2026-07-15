import "server-only";
import { tool, type ToolSet } from "ai";
import type { Authz } from "../authz";
import { ForbiddenError } from "../authz";
import { canRunTool } from "./gate";
import { READ_TOOLS } from "./tools";
import { WRITE_TOOLS } from "./tools-write";
import type { AssistantToolDef, ToolResult } from "./types";

/**
 * Builds the per-turn AI-SDK ToolSet, ported from beaconhs. The model only
 * ever SEES tools the current user may run (first gate); every execute()
 * re-checks the gate (second gate); write tools add a third gate at commit
 * time in /api/assistant/commit.
 */

const ASSISTANT_TOOLS: AssistantToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

function safeErrorMessage(e: unknown): string {
  // Never surface raw error text to the model — it could carry secrets/PII.
  if (e instanceof ForbiddenError) return "forbidden";
  return "tool_failed";
}

/** Construct the permission-bound tool set the model may use this turn. */
export function buildToolRegistry(authz: Authz): ToolSet {
  const runnable = ASSISTANT_TOOLS.filter((t) => canRunTool(authz, t));
  const entries = runnable.map((t) => {
    // Shared execute wrapper: defensive gate re-check + never-throw contract.
    const execute = async (args: unknown): Promise<ToolResult> => {
      if (!canRunTool(authz, t)) return { ok: false, error: "forbidden" };
      try {
        return await t.execute(args, authz);
      } catch (e) {
        console.warn(`[assistant] tool ${t.name} failed`, e);
        return { ok: false, error: safeErrorMessage(e) };
      }
    };
    return [
      t.name,
      tool({ description: t.description, inputSchema: t.inputSchema, execute }),
    ] as const;
  });
  return Object.fromEntries(entries);
}
