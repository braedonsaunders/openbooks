import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApplicationError } from "../application/errors";

function display(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function mcpSuccess(
  structuredContent: Record<string, unknown>,
  summary?: string,
): CallToolResult {
  return {
    structuredContent,
    content: [{
      type: "text",
      text: summary ?? display(structuredContent),
    }],
  };
}

export function mcpFailure(error: unknown): CallToolResult {
  if (error instanceof ApplicationError) {
    const structuredContent = {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
    return {
      isError: true,
      structuredContent,
      content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    };
  }

  console.warn("[mcp] unhandled tool error", error);
  return {
    isError: true,
    structuredContent: {
      ok: false,
      error: { code: "internal_error", message: "The operation failed." },
    },
    content: [{ type: "text", text: "internal_error: The operation failed." }],
  };
}
