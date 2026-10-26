import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { getAuthz } from "@/lib/authz";
import { canReadDocumentKind } from "@/lib/flow-subject-authz";
import { findPossibleDuplicates } from "@/lib/document-duplicates";
import { notFound } from "@/lib/api/responses";
import { canonicalDecimal, compareDecimal } from "@openbooks/engine/money/decimal";

export const runtime = "nodejs";

const querySchema = z
  .object({
    kind: z.enum(["customer_invoice", "vendor_bill", "vendor_credit"]),
    partyId: uuidString(),
    documentDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    total: z.string().min(1).max(32).optional(),
    referenceNumber: z.string().max(200).optional(),
    excludeId: uuidString().optional(),
  })
  .strict();

/**
 * Possible duplicates for a duplicate warning, both live while the vendor
 * invoice number is typed and as a confirm-before-save check.
 *
 * - Vendor bills and credits: the same vendor and the same normalised
 *   reference (case, spaces and punctuation ignored), whatever the date or
 *   amount. `kind`, `partyId` and `referenceNumber` are enough; a blank
 *   reference matches nothing.
 * - Customer invoices: the same customer, document date and total, all three
 *   required.
 *
 * A warning, never a refusal: the drawer shows the matches and the operator
 * may save anyway. Voided documents never match, `excludeId` leaves out the
 * document being edited, and matches stay inside the caller's subsidiary
 * scope.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = querySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "kind and partyId are required, with referenceNumber for bills and credits or documentDate (YYYY-MM-DD) and total for invoices; excludeId must be a document id",
        },
        { status: 400 },
      );
    }
    const { kind, partyId, documentDate, total, referenceNumber, excludeId } = parsed.data;
    if (!canReadDocumentKind(authz, kind)) return notFound("record");
    let amount: string | null = null;
    if (total !== undefined) {
      amount = canonicalDecimal(total, 4);
      if (amount === null || compareDecimal(amount, "0") <= 0) {
        return NextResponse.json(
          { error: "total must be a positive exact decimal" },
          { status: 400 },
        );
      }
    }
    if (kind === "customer_invoice" && (!documentDate || amount === null)) {
      return NextResponse.json(
        { error: "documentDate and total are required to check an invoice for duplicates" },
        { status: 400 },
      );
    }
    const duplicates = await findPossibleDuplicates({
      orgId: authz.user.orgId,
      kind,
      partyId,
      documentDate,
      total: amount,
      reference: referenceNumber,
      excludeId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return NextResponse.json({ duplicates });
  },
});
