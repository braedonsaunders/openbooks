import type { McpCatalogTool, McpToolAuditEvent } from "@braedonsaunders/appkit-mcp";

/** Wrap catalog execution so audit persistence is awaited before a result can escape. */
export function withAwaitedToolAudit<Context>(
  tools: readonly McpCatalogTool<Context>[],
  audit: (event: McpToolAuditEvent) => Promise<void>,
  describeError: (error: unknown) => { summary: string; statusCode: number },
  now: () => number = Date.now,
): readonly McpCatalogTool<Context>[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (context, input) => {
      const startedAt = now();
      try {
        const result = await tool.execute(context, input);
        await audit({ name: tool.name, durationMs: now() - startedAt, status: "ok" });
        return result;
      } catch (error) {
        const mapped = describeError(error);
        await audit({
          name: tool.name,
          durationMs: now() - startedAt,
          status: "error",
          errorSummary: mapped.summary.slice(0, 500),
          statusCode: mapped.statusCode,
        });
        throw error;
      }
    },
  }));
}
