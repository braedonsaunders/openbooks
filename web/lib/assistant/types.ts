import type { ZodTypeAny } from "zod";
import type { Authz } from "../authz";

/**
 * Tool framework for the agentic assistant. A tool is a permission-gated
 * capability the model may call. Two independent gates protect every call:
 * (1) the registry only EXPOSES tools the user may run (buildToolRegistry),
 * and (2) each execute() re-checks the gate defensively. Write tools add a
 * third gate at commit time (the real module permission) — see the
 * /api/assistant/commit route.
 */

/** Permission gate for a tool. Delegates to `can()` so wildcards work. */
export type PermissionRule =
  | { mode: "public" } // still requires assistant.use at the registry gate
  | { mode: "anyOf"; perms: string[] }
  | { mode: "allOf"; perms: string[] };

type ToolCategory = "read" | "search" | "write";

/** Structured, model-readable result. Tools NEVER throw to the loop — a failure
 *  is returned as `{ ok: false }` so one bad call can't crash the turn. */
export type ToolResult = { ok: true; data: unknown; note?: string } | { ok: false; error: string };

export type AssistantToolDef = {
  /** snake_case, model-facing. */
  name: string;
  /** Model-facing description. State the scope + that the tool is read-only or
   *  requires the user to confirm. */
  description: string;
  category: ToolCategory;
  inputSchema: ZodTypeAny;
  gate: PermissionRule;
  /** Write tools set this; the loop NEVER auto-commits a tool that requires it. */
  requiresConfirmation?: boolean;
  /** Per-call handler. Receives the (already schema-validated) args + the
   *  resolved authorization. Must return a ToolResult and must not throw. */
  execute: (args: unknown, authz: Authz) => Promise<ToolResult>;
};

/** Cap a long text field so a single record can't blow the model context. */
export function truncateText(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const v = String(value);
  return v.length > max ? `${v.slice(0, max)}…[truncated]` : v;
}
