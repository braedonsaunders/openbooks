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

/** Execute one named tool through the same gates and error contract as AI SDK calls. */
export async function executeAssistantTool(
  authz: Authz,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const definition = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
  if (!definition || !canRunTool(authz, definition)) return { ok: false, error: "forbidden" };
  try {
    return await definition.execute(args, authz);
  } catch (error) {
    console.warn(`[assistant] tool ${name} failed`, error);
    return { ok: false, error: safeErrorMessage(error) };
  }
}

/** Construct the permission-bound tool set the model may use this turn. */
export function buildToolRegistry(authz: Authz): ToolSet {
  const runnable = ASSISTANT_TOOLS.filter((t) => canRunTool(authz, t));
  const entries = runnable.map((t) => {
    // Shared execute wrapper: defensive gate re-check + never-throw contract.
    const execute = (args: unknown): Promise<ToolResult> => executeAssistantTool(authz, t.name, args);
    return [
      t.name,
      tool({ description: t.description, inputSchema: t.inputSchema, execute }),
    ] as const;
  });
  return Object.fromEntries(entries);
}
