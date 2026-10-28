import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/responses";
import { isUuid, uuidString } from "@openbooks/engine/platform/identifiers";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { readApCaptureDetail } from "@/lib/ap-capture-reads";
import { reviewApCapture } from "@/lib/ap-capture-actions";

const normalizedText = (max: number, description: string) =>
  z.string().trim().max(max).nullable().describe(description);
const normalizedDate = z
  .string()
  .refine(
    (value) => value === "" || isIsoCalendarDate(value),
    "invoice dates must be real calendar dates (YYYY-MM-DD)",
  )
  .nullable()
  .describe("Invoice or due date as a real calendar date, or null when unknown.");
const captureMoney = z
  .string()
  .regex(/^[+-]?\d+(?:\.\d{1,4})?$/, "invalid_capture_amount")
  .describe("Exact decimal amount as text, never a JSON number.");
const normalizedLineSchema = z
  .strictObject({
    description: z.string().trim().max(1000).describe("Invoice line description."),
    productCode: normalizedText(200, "Supplier product code, or null when unknown."),
    quantity: captureMoney.describe("Exact line quantity as decimal text."),
    unit: normalizedText(50, "Unit label, or null when unknown."),
    unitPrice: captureMoney.describe("Exact unit price as decimal text."),
    amount: captureMoney.describe("Exact line amount as decimal text."),
    taxAmount: captureMoney.describe("Exact line tax as decimal text."),
    accountId: uuidString().nullable().optional().describe("Optional account UUID for this line."),
    itemId: uuidString().nullable().optional().describe("Optional item UUID for this line."),
    purchaseOrderLineId: uuidString()
      .nullable()
      .optional()
      .describe("Optional matched purchase-order line UUID."),
    confidence: captureMoney
      .nullable()
      .describe("Extraction confidence as an exact decimal string, or null."),
  })
  .describe("Supplier invoice line values and optional linked records.");
const normalizedCaptureSchema = z
  .strictObject({
    vendorName: normalizedText(500, "Supplier name, or null when unknown."),
    vendorTaxId: normalizedText(200, "Supplier tax identifier, or null when unknown."),
    invoiceNumber: normalizedText(200, "Invoice number, or null when unknown."),
    invoiceDate: normalizedDate,
    dueDate: normalizedDate,
    purchaseOrderNumber: normalizedText(
      200,
      "Purchase-order number printed on the invoice, or null.",
    ),
    currency: z
      .string()
      .trim()
      .max(3)
      .nullable()
      .describe("Three-letter ISO currency code, uppercased by the review service, or null."),
    subtotal: captureMoney.nullable().describe("Exact invoice subtotal as decimal text, or null."),
    taxTotal: captureMoney.nullable().describe("Exact total tax as decimal text, or null."),
    total: captureMoney.nullable().describe("Exact invoice total as decimal text, or null."),
    memo: normalizedText(2000, "Invoice memo, or null when blank."),
    lines: z
      .array(normalizedLineSchema)
      .max(500)
      .describe("Invoice lines, with exact decimal amounts."),
  })
  .describe("Corrected normalized supplier document data.");
export const apCaptureReviewBodySchema = z.strictObject({
  documentKind: z
    .enum(["vendor_bill", "vendor_credit"])
    .optional()
    .describe("Convert the capture as a vendor bill or credit."),
  expectedUpdatedAt: z
    .string()
    .max(100)
    .optional()
    .describe("Exact capture revision token copied from get_ap_capture_item."),
  normalized: normalizedCaptureSchema.describe("Corrected extraction values."),
  purchaseOrderId: uuidString()
    .nullable()
    .optional()
    .describe("Matched purchase-order UUID, or null to clear it."),
  vendorId: uuidString()
    .nullable()
    .optional()
    .describe("Matched supplier party UUID, or null to clear it."),
});

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "ap.read",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = params;
    // A malformed id names nothing: same answer as an unknown one, never a
    // PostgreSQL uuid cast error escaping as a 500.
    if (!isUuid(id)) return notFound("record");
    const detail = await readApCaptureDetail({
      orgId: gate.user.orgId,
      captureItemId: id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return detail ? NextResponse.json(detail) : notFound("record");
  },
});

export const PATCH = defineRoute({
  permission: "ap.create",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  params: z.object({ id: uuidString() }),
  invalidParamsNotFound: "record",
  body: apCaptureReviewBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params: { id }, body }) => reviewApCapture(gate, id, body),
});
