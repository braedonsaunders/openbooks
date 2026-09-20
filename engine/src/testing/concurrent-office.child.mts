/**
 * Concurrent-office child driver (wave 3). Each invocation runs ONE
 * scheduler entry point in a FRESH operating-system process with its own
 * connection pool — the closest faithful simulation of two replicas
 * claiming the same work at once. The parent test seeds everything, forks
 * two of these concurrently, and asserts a single financial effect.
 *
 * Usage: concurrent-office.child.mts <mode> <orgId> <arg>
 *   recurring <orgId> <asOf>            -> runDueRecurringSchedules(asOf)
 *   dunning   <orgId> <asOf>            -> runDunningForOrg(orgId, asOf)
 *   report    <orgId> <runId>           -> processScheduledReportRun(runId, stub render)
 *
 * Prints one JSON result line and exits 0. Never touches fixtures (no
 * pool leases cross processes); the parent owns all setup and teardown.
 */
import { runDueRecurringSchedules } from "../billing/recurring.ts";
import { runDunningForOrg } from "../receivables/dunning.ts";
import { processScheduledReportRun } from "../delivery/report-delivery.ts";
import { refreshSandbox } from "../sandbox/lifecycle.ts";

const [mode, orgId, arg] = process.argv.slice(2);
if (!mode || !orgId || !arg) {
  console.error("usage: concurrent-office.child.mts <recurring|dunning|report|sandbox-refresh> <orgId> <asOf|runId|sandboxId>");
  process.exit(2);
}

try {
  if (mode === "recurring") {
    const result = await runDueRecurringSchedules(arg);
    console.log(JSON.stringify({ ok: true, result }));
  } else if (mode === "dunning") {
    const result = await runDunningForOrg(orgId, arg);
    console.log(JSON.stringify({ ok: true, result }));
  } else if (mode === "report") {
    const result = await processScheduledReportRun(
      arg,
      async () => Buffer.from("%PDF-1.7\nconcurrent office stub"),
    );
    console.log(JSON.stringify({ ok: true, result }));
  } else if (mode === "sandbox-refresh") {
    await refreshSandbox(arg, { keepCustomizations: true });
    console.log(JSON.stringify({ ok: true, result: { refreshed: arg } }));
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
process.exit();
