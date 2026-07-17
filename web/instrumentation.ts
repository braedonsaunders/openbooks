/**
 * Next.js instrumentation — runs once when the server process starts. Boots the
 * scheduled-script cron runner (engine/src/scheduler.ts) and, when enabled, the
 * built-in SFTP server (engine/src/sftp/manager.ts).
 *
 * Only runs in the nodejs server runtime, not during builds.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { ensureScheduler } = await import('@openbooks/engine/src/scheduler.ts')
  ensureScheduler()
  const { ensureSftpServer } = await import('@openbooks/engine/src/sftp/manager.ts')
  await ensureSftpServer()

  // Flow emails with `attachPdf` render through the web-only record-PDF
  // pipeline (org template store + values builder + Chromium printer). The
  // engine can't import web/lib, so it exposes a renderer hook this process
  // fills at boot; the standalone worker has no renderer and degrades to
  // sending without the attachment.
  const { registerFlowPdfRenderer } = await import('@openbooks/engine/src/flows/index.ts')
  registerFlowPdfRenderer(async ({ orgId, subjectKind, subjectId }) => {
    const { PDF_RECORD_TYPE_BY_KEY } = await import('./lib/pdf-templates/catalog')
    const meta = PDF_RECORD_TYPE_BY_KEY[subjectKind]
    if (!meta) return null
    const [{ resolvePdfTemplate }, { loadPdfRecordValues }, { mergeAndPrintPdf }] =
      await Promise.all([
        import('./lib/pdf-templates/store'),
        import('./lib/pdf-templates/values'),
        import('./lib/pdf-templates/render'),
      ])
    const [tpl, record] = await Promise.all([
      resolvePdfTemplate(orgId, subjectKind, null),
      loadPdfRecordValues(subjectKind, orgId, subjectId),
    ])
    if (!tpl || !record) return null
    const pdf = await mergeAndPrintPdf(tpl, record.values)
    return {
      filename: `${meta.docTitle} ${record.reference}.pdf`.replace(/[\\/:*?"<>|]/g, '-'),
      content: pdf,
      contentType: 'application/pdf' as const,
    }
  })
}
