import "server-only";

import {
  loadBusinessDate,
  loadEngineComposition,
  loadFlowModule,
  loadScheduleNoticeHooks,
} from "@/lib/engine-composition";

/**
 * Engine and web hooks a module graph needs before it posts, edits or voids
 * documents, runs scripts or resolves flow approvals: the engine composition
 * root plus the hooks only the web process can fill.
 *
 * The production server loads @openbooks/engine once, from the prebuilt
 * package, so a route bundle does not contain the composition graph. The dev
 * server still compiles that package per graph. Registration is idempotent,
 * and instrumentation, pages, and request handlers all install for the graph
 * they run in.
 */
export async function installWebProcessSeams(): Promise<void> {
  // Flow emails with `attachPdf` render through the web-only record-PDF
  // pipeline (org template store + values builder + Chromium printer). The
  // engine can't import web/lib, so it exposes a renderer hook this process
  // fills at boot; the standalone worker has no renderer and degrades to
  // sending without the attachment.
  const { registerFlowPdfRenderer } = await loadFlowModule();

  // Web-owned approval releases (field tickets, timesheet weeks, crew time
  // batches): the engine owns routing and gate decisions; these web hooks
  // supply what approval means for each record. See web/lib/flow-approval-releases.ts.
  const { registerFlowApprovalReleaseHandlers } = await import("./flow-approval-releases");
  await registerFlowApprovalReleaseHandlers();

  // Engine seams (script journal writer, ...): the web process posts and
  // runs scripts, so install the composition root beside the web handlers.
  const { installEngineSeams } = await loadEngineComposition();
  installEngineSeams();
  const { registerScheduleNoticeDelivery } = await loadScheduleNoticeHooks();
  const { deliverScheduleNotices } = await import("./scheduling/notify");
  registerScheduleNoticeDelivery(async (args) => {
    await deliverScheduleNotices(args);
  });

  registerFlowPdfRenderer(async ({ orgId, subjectKind, subjectId }) => {
    const { PDF_RECORD_TYPE_BY_KEY } = await import("./pdf-templates/catalog");
    const meta = PDF_RECORD_TYPE_BY_KEY[subjectKind];
    if (!meta) return null;
    const [
      { resolvePdfTemplate },
      { loadPdfRecordValues },
      { mergeAndPrintPdf },
      { businessToday },
    ] = await Promise.all([
      import("./pdf-templates/store"),
      import("./pdf-templates/values"),
      import("./pdf-templates/render"),
      loadBusinessDate(),
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

let requestSeams: Promise<void> | undefined;

/**
 * Installs the process seams once in the calling module graph. Outside the
 * Next.js server there is a single graph and each process entry installs its
 * seams itself, so this only acts inside the Next.js runtime.
 */
export function ensureRequestSeams(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return Promise.resolve();
  requestSeams ??= installWebProcessSeams().catch((error: unknown) => {
    requestSeams = undefined;
    throw error;
  });
  return requestSeams;
}
