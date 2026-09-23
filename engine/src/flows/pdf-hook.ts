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
  /**
   * Which template design produced the attached PDF, when the renderer
   * knows it: id + revision + content hash, recorded on the outbox payload
   * beside the bytes. Optional so renderer-less processes keep working.
   */
  template?: {
    id: string | null;
    revision: number | null;
    hash: string;
  };
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

/**
 * Flatten an attachment's template provenance for the outbox payload meta,
 * which carries string values only (parseFlowEmailPayload enforces it). A
 * starter-rendered PDF has no id or revision — its content hash still rides
 * along, so the issuance record always names the exact design.
 */
export function flowPdfTemplateMeta(
  template: FlowPdfAttachment["template"],
): Record<string, string> {
  if (!template) return {};
  return {
    ...(template.id ? { pdfTemplateId: template.id } : {}),
    ...(template.revision !== null && template.revision !== undefined
      ? { pdfTemplateRevision: String(template.revision) }
      : {}),
    pdfTemplateHash: template.hash,
  };
}
