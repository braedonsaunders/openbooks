import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { withAwaitedToolAudit } from "./audited-catalog";
import type { McpCatalogTool, McpToolAuditEvent } from "@braedonsaunders/appkit-mcp";

const describeError = (error: unknown) => ({
  summary: error instanceof Error ? error.message : "tool failed",
  statusCode: 500,
});

test("tool result waits for audit persistence on success and replay", async () => {
  const events: McpToolAuditEvent[] = [];
  let executions = 0;
  let releaseAudit!: () => void;
  const auditPending = new Promise<void>((resolve) => { releaseAudit = resolve; });
  const tool: McpCatalogTool<null> = {
    name: "read_example",
    description: "Read example",
    inputSchema: z.object({}),
    readOnly: true,
    async execute() {
      executions++;
      return { ok: true };
    },
  };
  const [audited] = withAwaitedToolAudit([tool], async (event) => {
    events.push(event);
    await auditPending;
  }, describeError, () => 10);
  assert.ok(audited);

  let firstSettled = false;
  const first = audited.execute(null, {}).finally(() => { firstSettled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(firstSettled, false);
  assert.equal(events[0]?.status, "ok");
  releaseAudit();
  assert.deepEqual(await first, { ok: true });

  // A replay is still a successful invocation and must also await its audit.
  await audited.execute(null, {});
  assert.equal(executions, 2);
  assert.deepEqual(events.map(({ status }) => status), ["ok", "ok"]);
});

test("failed tool executions are audited and audit failure rejects the handler", async () => {
  const events: McpToolAuditEvent[] = [];
  const tool: McpCatalogTool<null> = {
    name: "write_example",
    description: "Write example",
    inputSchema: z.object({}),
    readOnly: false,
    async execute() { throw new Error("governed refusal"); },
  };
  const [audited] = withAwaitedToolAudit([tool], async (event) => { events.push(event); }, describeError, () => 10);
  assert.ok(audited);
  await assert.rejects(audited.execute(null, {}), /governed refusal/);
  assert.deepEqual(events.map(({ status, errorSummary }) => [status, errorSummary]), [["error", "governed refusal"]]);

  const [auditFailure] = withAwaitedToolAudit([tool], async () => { throw new Error("audit unavailable"); }, describeError, () => 10);
  assert.ok(auditFailure);
  await assert.rejects(auditFailure.execute(null, {}), /audit unavailable/);
});
