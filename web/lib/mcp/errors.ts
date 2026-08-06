import { ZodError } from "zod";
import type { McpErrorShape } from "@appkit/mcp";
import { ApplicationError } from "../application/errors";

/**
 * An assistant tool reported a governed failure ({ ok: false }). Thrown so the
 * shared catalog runtime renders it through the one failure contract instead
 * of a second shape.
 */
export class AssistantToolFailure extends Error {
  readonly name = "AssistantToolFailure";

  constructor(readonly reason: string) {
    super(reason);
  }
}

const MAX_ISSUES = 10;

/**
 * The only errors allowed to reach the model, mapped to safe shapes:
 * application-layer errors (already transport-neutral), governed assistant
 * failures, and input-validation issues — actionable for an agent instead of
 * an opaque internal_error. Everything else stays generic.
 */
export function mapMcpError(error: unknown): McpErrorShape | null {
  if (error instanceof ApplicationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof AssistantToolFailure) {
    return {
      code: error.reason === "forbidden" ? "forbidden" : "tool_failed",
      message: error.reason,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "invalid_input",
      message: "Input failed validation.",
      details: {
        issues: error.issues.slice(0, MAX_ISSUES).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }
  console.warn("[mcp] unhandled tool error", error);
  return null;
}

/** Audit status code for a thrown tool error. */
export function mcpErrorStatus(error: unknown): number {
  if (error instanceof ApplicationError) return error.status;
  if (error instanceof AssistantToolFailure) {
    return error.reason === "forbidden" ? 403 : 500;
  }
  if (error instanceof ZodError) return 422;
  return 500;
}
