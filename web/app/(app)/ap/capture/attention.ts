import type { CaptureIssue, NormalizedCapture } from "@openbooks/engine/payables/ap-capture";

/**
 * Which review fields need a person's attention, in the order the review
 * form shows them. Enter in a field moves to the next one of these, so a
 * clean capture is confirmed in a few keystrokes and a messy one walks the
 * reviewer through exactly what the reader was unsure of.
 *
 * A field needs attention when it is empty but required, when a validation
 * issue names it, or when the reader's stored confidence for it is below the
 * organization's capture threshold. Captures without stored confidence fall
 * back to the empty and issue rules alone.
 */

export type CaptureFieldEvidence = {
  fieldKey: string;
  lineIndex: number | null;
  confidence: string | null;
};

const LINE_FIELDS = [
  "description",
  "account",
  "quantity",
  "unitPrice",
  "amount",
  "taxAmount",
] as const;
type LineField = (typeof LINE_FIELDS)[number];

/** Every review field key in form order. */
export function captureFieldOrder(lineCount: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    for (const field of LINE_FIELDS) lines.push(`line:${index}:${field}`);
  }
  return [
    "vendor",
    "invoiceNumber",
    "invoiceDate",
    "dueDate",
    "currency",
    "purchaseOrder",
    "memo",
    ...lines,
    "subtotal",
    "taxTotal",
    "total",
  ];
}

const HEADER_FIELD_BY_ISSUE_FIELD: Record<string, string> = {
  vendorName: "vendor",
  vendorTaxId: "vendor",
  invoiceNumber: "invoiceNumber",
  invoiceDate: "invoiceDate",
  dueDate: "dueDate",
  currency: "currency",
  purchaseOrderNumber: "purchaseOrder",
  subtotal: "subtotal",
  taxTotal: "taxTotal",
  total: "total",
};

const HEADER_FIELD_BY_ISSUE_CODE: Record<string, string> = {
  vendor_unresolved: "vendor",
  purchase_order_unresolved: "purchaseOrder",
  purchase_order_out_of_scope: "purchaseOrder",
  possible_duplicate: "invoiceNumber",
  subtotal_mismatch: "subtotal",
  line_tax_mismatch: "taxTotal",
  total_mismatch: "total",
};

function lineFieldForIssue(issue: CaptureIssue): LineField[] {
  if (issue.field && (LINE_FIELDS as readonly string[]).includes(issue.field))
    return [issue.field as LineField];
  switch (issue.code) {
    case "account_unresolved":
      return ["account"];
    case "po_price_variance":
      return ["unitPrice"];
    case "po_quantity_exceeded":
    case "receipt_quantity_shortfall":
      return ["quantity"];
    case "po_line_unmatched":
    case "missing_line_description":
      return ["description"];
    case "low_confidence":
      return ["description", "amount"];
    default:
      return ["amount"];
  }
}

const EVIDENCE_FIELD: Record<string, string> = {
  vendorName: "vendor",
  invoiceNumber: "invoiceNumber",
  invoiceDate: "invoiceDate",
  dueDate: "dueDate",
  currency: "currency",
  purchaseOrderNumber: "purchaseOrder",
  subtotal: "subtotal",
  taxTotal: "taxTotal",
  total: "total",
  "lines.description": "description",
  "lines.amount": "amount",
  "lines.quantity": "quantity",
  "lines.unitPrice": "unitPrice",
};

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

export function captureAttentionKeys(input: {
  form: NormalizedCapture;
  vendorId: string;
  issues: readonly CaptureIssue[];
  evidence: readonly CaptureFieldEvidence[];
  /** Organization confidence threshold, 0–1 as decimal text. */
  threshold: string;
}): Set<string> {
  const keys = new Set<string>();
  const { form } = input;
  if (!input.vendorId) keys.add("vendor");
  if (blank(form.invoiceNumber)) keys.add("invoiceNumber");
  if (blank(form.invoiceDate)) keys.add("invoiceDate");
  if (blank(form.currency)) keys.add("currency");
  if (blank(form.total)) keys.add("total");
  form.lines.forEach((line, index) => {
    if (!line.accountId && !line.purchaseOrderLineId) keys.add(`line:${index}:account`);
    if (blank(line.description)) keys.add(`line:${index}:description`);
  });
  for (const issue of input.issues) {
    if (issue.lineIndex !== null && issue.lineIndex !== undefined) {
      for (const field of lineFieldForIssue(issue)) keys.add(`line:${issue.lineIndex}:${field}`);
      continue;
    }
    const byField = issue.field ? HEADER_FIELD_BY_ISSUE_FIELD[issue.field] : undefined;
    const byCode = HEADER_FIELD_BY_ISSUE_CODE[issue.code];
    if (byField) keys.add(byField);
    if (byCode) keys.add(byCode);
  }
  const threshold = Number(input.threshold);
  if (Number.isFinite(threshold)) {
    for (const item of input.evidence) {
      if (item.confidence === null || item.confidence === undefined) continue;
      const confidence = Number(item.confidence);
      if (!Number.isFinite(confidence) || confidence >= threshold) continue;
      const field = EVIDENCE_FIELD[item.fieldKey];
      if (!field) continue;
      if (item.fieldKey.startsWith("lines.")) {
        if (item.lineIndex !== null && item.lineIndex < form.lines.length)
          keys.add(`line:${item.lineIndex}:${field}`);
      } else {
        keys.add(field);
      }
    }
  }
  return keys;
}

/**
 * The next field to visit after `current`: the next attention field in form
 * order that has not been confirmed, wrapping around; null when none remain.
 */
export function nextAttentionKey(
  order: readonly string[],
  attention: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
  current: string | null,
): string | null {
  const pending = order.filter(
    (key) => attention.has(key) && !confirmed.has(key) && key !== current,
  );
  if (pending.length === 0) return null;
  if (current === null) return pending[0]!;
  const position = order.indexOf(current);
  return pending.find((key) => order.indexOf(key) > position) ?? pending[0]!;
}
