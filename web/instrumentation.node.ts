/** Node-only OpenBooks process services registered by Next.js instrumentation. */
export async function registerNodeInstrumentation() {
  // OTel traces/metrics when OTEL_EXPORTER_OTLP_ENDPOINT is configured; a free
  // no-op otherwise (see engine telemetry.ts). First, so boot is observable.
  const { startTelemetry } = await import('@openbooks/engine/src/platform/telemetry.ts')
  await startTelemetry()
  const { assertSafeRuntimeDatabaseRole } = await import('@openbooks/engine/src/platform/db.ts')
  await assertSafeRuntimeDatabaseRole()
  const { ensureScheduler } = await import('@openbooks/engine/src/scheduling/scheduler.ts')
  const { resolveWebSchedulerMode } = await import('@openbooks/engine/src/scheduling/mode.ts')
  const { registerContinuousCloseEnricher } = await import('@openbooks/engine/src/continuous-close/continuous-close.ts')
  const { enrichContinuousCloseRun } = await import('./lib/assistant/continuous-close-agent')
  registerContinuousCloseEnricher(enrichContinuousCloseRun)
  // Scheduled work runs in the worker process (npm run worker), which calls
  // ensureScheduler() unconditionally. This web replica schedules only as an
  // explicit single-process opt-in (OPENBOOKS_RUN_SCHEDULER=1), and never
  // under `next dev` — see engine/src/scheduling/mode.ts.
  const decision = resolveWebSchedulerMode(process.env)
  if (decision.enabled) {
    ensureScheduler()
    // HR-16 automation scan on the same 60-second topology (own advisory
    // claim key, same mode decision) — web-composed because no engine
    // module may depend on the automations module.
    const { ensureAutomationTick } = await import('@openbooks/engine/src/automations/tick.ts')
    ensureAutomationTick()
  }
  console.log(decision.logLine)
  const { ensureSftpServer } = await import('@openbooks/engine/src/sftp/manager.ts')
  await ensureSftpServer()

  // Flow emails with `attachPdf` render through the web-only record-PDF
  // pipeline (org template store + values builder + Chromium printer). The
  // engine can't import web/lib, so it exposes a renderer hook this process
  // fills at boot; the standalone worker has no renderer and degrades to
  // sending without the attachment.
  const {
    registerFlowPdfRenderer,
  } = await import('@openbooks/engine/src/flows/index.ts')

  // Web-owned approval releases (field tickets, timesheet weeks, crew time
  // batches): the engine owns routing and gate decisions; these web hooks
  // supply what approval means for each record. See web/lib/flow-approval-releases.ts.
  const { registerFlowApprovalReleaseHandlers } = await import('./lib/flow-approval-releases')
  await registerFlowApprovalReleaseHandlers()

  registerFlowPdfRenderer(async ({ orgId, subjectKind, subjectId }) => {
    const { PDF_RECORD_TYPE_BY_KEY } = await import('./lib/pdf-templates/catalog')
    const meta = PDF_RECORD_TYPE_BY_KEY[subjectKind]
    if (!meta) return null
    const [{ resolvePdfTemplate }, { loadPdfRecordValues }, { mergeAndPrintPdf }, { businessToday }] =
      await Promise.all([
        import('./lib/pdf-templates/store'),
        import('./lib/pdf-templates/values'),
        import('./lib/pdf-templates/render'),
        import('@openbooks/engine/src/platform/business-date.ts'),
      ])
    const [tpl, record] = await Promise.all([
      resolvePdfTemplate(orgId, subjectKind, null),
      // System renderer: flows authorize the run, not a user subsidiary
      // scope — null declares that posture explicitly at the load.
      loadPdfRecordValues(subjectKind, orgId, subjectId, null),
    ])
    if (!tpl || !record) return null
    const pdf = await mergeAndPrintPdf(tpl, record.values)
    const stamp = await businessToday(orgId)
    return {
      filename: `${meta.docTitle} ${record.reference}-${stamp}.pdf`.replace(/[\\/:*?"<>|]/g, '-'),
      content: pdf,
      contentType: 'application/pdf' as const,
      // Which template design produced this attachment: the flow executor
      // records it on the durable outbox payload beside the bytes.
      template: {
        id: tpl.provenance.templateId,
        revision: tpl.provenance.revision,
        hash: tpl.provenance.contentHash,
      },
    }
  })
}
