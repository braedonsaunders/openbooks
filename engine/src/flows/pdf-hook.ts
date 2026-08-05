/**
 * Record-PDF renderer hook for flow emails (`send_email` with `attachPdf`).
 *
 * The record-PDF pipeline (org template store + record-values builder +
 * Chromium printer) lives in web/lib/pdf-templates — a layer the engine
 * package cannot import. The web process registers a renderer at boot
 * (web/instrumentation.ts); the executor calls whatever is registered.
 * Processes without a renderer (the standalone worker) degrade gracefully:
 * the email still sends, with a recorded warning instead of an attachment.
 */

export interface FlowPdfAttachment {
  filename: string;
  content: Buffer;
  contentType: "application/pdf";
}

export type FlowPdfRenderer = (args: {
  orgId: string;
  subjectKind: string;
  subjectId: string;
}) => Promise<FlowPdfAttachment | null>;

let renderer: FlowPdfRenderer | null = null;

export function registerFlowPdfRenderer(fn: FlowPdfRenderer): void {
  renderer = fn;
}

/** Render the record's PDF, or null when no renderer/template applies. */
export async function renderFlowPdf(args: {
  orgId: string;
  subjectKind: string;
  subjectId: string;
}): Promise<FlowPdfAttachment | null> {
  if (!renderer) return null;
  return renderer(args);
}

export function hasFlowPdfRenderer(): boolean {
  return renderer !== null;
}
