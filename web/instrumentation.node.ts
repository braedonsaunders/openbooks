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
    registerFlowApprovalReleaseHandler,
    registerFlowPdfRenderer,
  } = await import('@openbooks/engine/src/flows/index.ts')

  // Field-ticket approval policy is tenant-authored in Flows. The engine owns
  // routing and gate decisions; this web hook supplies the product service
  // that atomically materializes ticket-owned project charges, provenance,
  // status, and audit evidence when the gate resolves. Time-entry approval and
  // payroll posting remain an independent lifecycle.
  registerFlowApprovalReleaseHandler('field_ticket', async ({
    subjectId,
    outcome,
    comment,
    ctx,
  }) => {
    if (!ctx.userId) throw new Error('field-ticket approval needs an acting user')
    const { releaseFieldTicketApproval } = await import('./lib/field-tickets')
    await releaseFieldTicketApproval(
      ctx.orgId,
      ctx.userId,
      subjectId,
      outcome,
      comment,
    )
  })

  // Timesheet approval routing is tenant-authored in Flows too. The engine
  // decides WHO approves and when the gates resolve; this supplies what
  // approval means for hours — stamping the approver across the week, or
  // returning it with the approver's reason attached.
  registerFlowApprovalReleaseHandler('timesheet_week', async ({
    subjectId,
    outcome,
    comment,
    ctx,
  }) => {
    if (!ctx.userId) throw new Error('timesheet approval needs an acting user')
    const { releaseTimesheetWeekApproval } = await import('./lib/timesheet-approval-release')
    await releaseTimesheetWeekApproval(ctx.orgId, ctx.userId, subjectId, outcome, comment)
  })

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
      loadPdfRecordValues(subjectKind, orgId, subjectId),
    ])
    if (!tpl || !record) return null
    const pdf = await mergeAndPrintPdf(tpl, record.values)
    const stamp = await businessToday(orgId)
    return {
      filename: `${meta.docTitle} ${record.reference}-${stamp}.pdf`.replace(/[\\/:*?"<>|]/g, '-'),
      content: pdf,
      contentType: 'application/pdf' as const,
    }
  })
}
