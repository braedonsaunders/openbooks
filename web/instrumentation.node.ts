/** Node-only OpenBooks process services registered by Next.js instrumentation. */
import type { SpanProcessor } from "@openbooks/engine/platform/telemetry";

export async function registerNodeInstrumentation() {
  const { startTelemetry } = await import("@openbooks/engine/platform/telemetry");
  // Per-route database profile (see lib/query-profile.ts). Off by default:
  // when the flag is unset neither the profiler nor its observer is loaded.
  const localSpanProcessors: SpanProcessor[] = [];
  if (process.env.OPENBOOKS_QUERY_PROFILE === "1") {
    const { startQueryProfile } = await import("./lib/query-profile");
    localSpanProcessors.push(startQueryProfile(process.env));
  }
  // Install local profiling and configured OTLP exporters in one provider,
  // before application boot. With neither configured this remains a no-op.
  await startTelemetry(process.env, localSpanProcessors);
  const { assertSafeRuntimeDatabaseRole } = await import("@openbooks/engine/platform/db");
  await assertSafeRuntimeDatabaseRole();
  const { resolveWebSchedulerMode } = await import("@openbooks/engine/scheduling/mode");
  const { registerContinuousCloseEnricher } =
    await import("@openbooks/engine/continuous-close/continuous-close");
  // Manual close runs still receive enrichment when the web scheduler is off.
  // Load the assistant's readers when enrichment is invoked, rather than during
  // process startup for unrelated requests such as sign-in and entity lists.
  registerContinuousCloseEnricher(async (input) => {
    const { enrichContinuousCloseRun } = await import("./lib/assistant/continuous-close-agent");
    return enrichContinuousCloseRun(input);
  });
  // Scheduled work runs in the worker process (npm run worker), which calls
  // ensureScheduler() unconditionally. This web replica schedules only as an
  // explicit single-process opt-in (OPENBOOKS_RUN_SCHEDULER=1), and never
  // under `next dev` — see engine/src/scheduling/mode.ts.
  const decision = resolveWebSchedulerMode(process.env);
  if (decision.enabled) {
    const { ensureScheduler } = await import("@openbooks/engine/scheduling/scheduler");
    const { registerWorkerDuty } = await import("@openbooks/engine/scheduling/duties");
    const { runDueJournalReversals } = await import("@openbooks/engine/ledger/journal-reversals");
    registerWorkerDuty({
      key: "journal-auto-reversals",
      run: async () => runDueJournalReversals(),
    });
    ensureScheduler();
    // HR-16 automation scan on the same 60-second topology (own advisory
    // claim key, same mode decision) — web-composed because no engine
    // module may depend on the automations module.
    const { ensureAutomationTick } = await import("@openbooks/engine/automations/tick");
    ensureAutomationTick();
  }
  console.log(decision.logLine);
  const { ensureSftpServer } = await import("@openbooks/engine/sftp/manager");
  await ensureSftpServer();

  // Engine and web hooks for this module graph; request handlers install the
  // same set in their own graph (see lib/process-seams.ts). This literal
  // import is the standalone trace for the composition root. Request bundles
  // load it through a computed specifier so the tracer does not walk that
  // root once per route.
  await import("@openbooks/engine/composition/install");
  const { installWebProcessSeams } = await import("./lib/process-seams");
  await installWebProcessSeams();
}
