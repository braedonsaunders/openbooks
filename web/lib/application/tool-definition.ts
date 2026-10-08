import "server-only";
import type { z, ZodTypeAny } from "zod";
import type { Authz } from "../authz";
import type { ToolTier } from "../assistant/types";
import type { ApplicationContext } from "./context";
import { invalidInput } from "./errors";
import { executeIdempotent } from "./idempotency";

export type ApplicationToolConfirmation = "never" | "always";

export interface ApplicationToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodTypeAny;
  readOnly: boolean;
  /** Mutation execution is wrapped by executeIdempotent in definition(). */
  mutationProtection: "none" | "execute-idempotent";
  destructive: boolean;
  openWorld: boolean;
  assistantConfirmation: ApplicationToolConfirmation;
  visibleTo: (authz: Authz) => boolean;
  /** Optional-feature key; adapters hide the tool while the org has it off. */
  featureKey?: string;
  /** Chat-payload tier; absent means "module" (only sent when activated). MCP ignores tiers. */
  tier?: ToolTier;
  execute: (context: ApplicationContext, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** One catalog entry; mutations run once per idempotency key through executeIdempotent. */
export function definition<T extends ZodTypeAny>(args: Omit<ApplicationToolDefinition, "execute" | "inputSchema" | "mutationProtection"> & {
  inputSchema: T;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
  authorizeReplay?: (context: ApplicationContext, input: z.infer<T>) => Promise<void>;
}): ApplicationToolDefinition {
  const { execute, inputSchema, authorizeReplay, ...metadata } = args;
  return {
    ...metadata,
    inputSchema,
    mutationProtection: metadata.readOnly ? "none" : "execute-idempotent",
    execute: async (context, input) => {
      const parsed = inputSchema.parse(input);
      if (metadata.readOnly) return execute(context, parsed);

      const idempotencyKey = (parsed as Record<string, unknown>).idempotencyKey;
      if (typeof idempotencyKey !== "string") {
        throw invalidInput(`${metadata.name} requires an idempotencyKey`);
      }
      const outcome = await executeIdempotent({
        context,
        operation: `mcp.${metadata.name}`,
        idempotencyKey,
        request: parsed,
        authorizeReplay: authorizeReplay ? () => authorizeReplay(context, parsed) : undefined,
        // The outer catalog claim owns API-key execution evidence. Nested
        // domain idempotency still runs in this same transaction, but must not
        // attempt to write a second transport event for the same command.
        execute: () => execute({ ...context, apiKeyId: null, requestAudit: undefined }, parsed),
      });
      return { ...outcome.value, replayed: outcome.replayed };
    },
  };
}
