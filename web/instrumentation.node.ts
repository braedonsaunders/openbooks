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

  // Flow emails with `attachPdf` render through the web-only record-PDF
  // pipeline (org template store + values builder + Chromium printer). The
  // engine can't import web/lib, so it exposes a renderer hook this process
  // fills at boot; the standalone worker has no renderer and degrades to
  // sending without the attachment.
  const { registerFlowPdfRenderer } = await import("@openbooks/engine/flows/module");

  // Web-owned approval releases (field tickets, timesheet weeks, crew time
  // batches): the engine owns routing and gate decisions; these web hooks
  // supply what approval means for each record. See web/lib/flow-approval-releases.ts.
  const { registerFlowApprovalReleaseHandlers } = await import("./lib/flow-approval-releases");
  await registerFlowApprovalReleaseHandlers();

  // Engine seams (script journal writer, ...): the web process posts and
  // runs scripts, so install the composition root beside the web handlers.
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
  const { registerScheduleNoticeDelivery } =
    await import("@openbooks/engine/schedule-boards/distribution-hooks");
  const { deliverScheduleNotices } = await import("./lib/scheduling/notify");
  registerScheduleNoticeDelivery(async (args) => {
    await deliverScheduleNotices(args);
  });

  registerFlowPdfRenderer(async ({ orgId, subjectKind, subjectId }) => {
    const { PDF_RECORD_TYPE_BY_KEY } = await import("./lib/pdf-templates/catalog");
    const meta = PDF_RECORD_TYPE_BY_KEY[subjectKind];
    if (!meta) return null;
    const [
      { resolvePdfTemplate },
      { loadPdfRecordValues },
      { mergeAndPrintPdf },
      { businessToday },
    ] = await Promise.all([
      import("./lib/pdf-templates/store"),
      import("./lib/pdf-templates/values"),
      import("./lib/pdf-templates/render"),
      import("@openbooks/engine/platform/business-date/module"),
    ]);
    const [tpl, record] = await Promise.all([
      resolvePdfTemplate(orgId, subjectKind, null),
      // System renderer: flows authorize the run, not a user subsidiary
      // scope — null declares that posture explicitly at the load.
      loadPdfRecordValues(subjectKind, orgId, subjectId, null),
    ]);
    if (!tpl || !record) return null;
    const pdf = await mergeAndPrintPdf(tpl, record.values);
    const stamp = await businessToday(orgId);
    return {
      filename: `${meta.docTitle} ${record.reference}-${stamp}.pdf`.replace(/[\\/:*?"<>|]/g, "-"),
      content: pdf,
      contentType: "application/pdf" as const,
      // Which template design produced this attachment: the flow executor
      // records it on the durable outbox payload beside the bytes.
      template: {
        id: tpl.provenance.templateId,
        revision: tpl.provenance.revision,
        hash: tpl.provenance.contentHash,
      },
    };
  });
}
