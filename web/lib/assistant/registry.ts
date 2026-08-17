import "server-only";
import { randomUUID } from "node:crypto";
import { tool, type ToolSet } from "ai";
import type { Authz } from "../authz";
import { can, ForbiddenError } from "../authz";
import { applicationContextFromSession } from "../application/context";
import {
  APPLICATION_TOOLS,
  executeApplicationTool,
} from "../application/tool-catalog";
import { canRunTool } from "./gate";
import { signApplicationCommand } from "./application-proposals";
import { READ_TOOLS } from "./tools";
import { ANALYTICS_TOOLS } from "./tools-analytics";
import { BANKING_TOOLS } from "./tools-banking";
import { FILE_TOOLS } from "./tools-files";
import { PAYROLL_TOOLS } from "./tools-payroll";
import { REPORTING_TOOLS } from "./tools-reports";
import { SETUP_TOOLS } from "./tools-setup";
import { WRITE_TOOLS } from "./tools-write";
import type { AssistantToolDef, ToolResult } from "./types";

/**
 * Builds the per-turn AI-SDK ToolSet. The model only
 * ever SEES tools the current user may run (first gate); every execute()
 * re-checks the gate (second gate); write tools add a third gate at commit
 * time in /api/assistant/commit.
 */

export const ASSISTANT_TOOLS: readonly AssistantToolDef[] = [
  ...READ_TOOLS,
  ...ANALYTICS_TOOLS,
  ...REPORTING_TOOLS,
  ...BANKING_TOOLS,
  ...PAYROLL_TOOLS,
  ...FILE_TOOLS,
  ...SETUP_TOOLS,
  ...WRITE_TOOLS,
];

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
  const applicationEntries = APPLICATION_TOOLS
    .filter((definition) =>
      definition.visibleTo(authz)
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
