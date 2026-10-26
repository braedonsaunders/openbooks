import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { filedBoxAmounts, formDefinition } from "@openbooks/engine/compliance/information-returns";
import {
  listInformationReturnExportRecipients,
  loadInformationReturnExportFiling,
} from "@openbooks/engine/compliance/information-return-route-queries";
import { guardSubsidiaryScope } from "@/lib/authz";
import { loadInformationReturnFilingScope } from "@/lib/compliance";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

// Keep CSV formula neutralization aligned with @openbooks/office's report
// serializer. Excel/Sheets evaluate cells beginning with =, +, -, @ (and can
// smuggle a prefix with tab/CR); numeric strings such as -42.50 are exempt so
// statutory amount columns retain their number semantics.
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/;

function guardCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && CSV_FORMULA_PREFIX.test(s) && !PLAIN_NUMBER.test(s)) {
    return `'${s}`;
  }
  return s;
}

function csvCell(value: unknown): string {
  const s = guardCsvCell(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Transmittal export: one row per included recipient, one column per statutory
 * box, plus the payer block. This is the file a filing agent or the IRS IRIS
 * bulk-upload consumes.
 *
 * The full TIN is deliberately NOT in this file — it stays sealed on the vendor
 * record. A transmittal needs the unmasked number, so it is entered in the
 * filing channel rather than dropped into a spreadsheet that gets emailed
 * around; the export carries the last four so rows can be reconciled.
 */
export const GET = defineRoute({
  permission: "compliance.file",
  feature: "informationReturns",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { orgId } = gate.user;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    // Entity isolation before any filing detail is read (same 404 as a missing filing).
    const filingScope = await loadInformationReturnFilingScope(orgId, id);
    if (!filingScope) return notFound("record");
    const scopeDenied = guardSubsidiaryScope(gate, filingScope.subsidiaryId);
    if (scopeDenied) return scopeDenied;

    const filing = await loadInformationReturnExportFiling(orgId, id);
    if (!filing) return notFound("record");
    const form = formDefinition(filing.form_type);

    const recipients = await listInformationReturnExportRecipients(orgId, id);

    const header = [
      "payer_name",
      "tax_year",
      "form_type",
      "currency",
      "corrected",
      "recipient_legal_name",
      "recipient_display_name",
      "tin_type",
      "tin_last4",
      "tax_classification",
      "address_line1",
      "address_line2",
      "city",
      "region",
      "postal_code",
      "country",
      ...form.boxes.map((box) => `box_${box.number}`),
    ];
    const lines = [header.join(",")];
    for (const r of recipients) {
      const amounts = filedBoxAmounts(r.computed_amounts, r.adjustments);
      lines.push(
        [
          filing.payer_name,
          filing.tax_year,
          filing.form_type,
          filing.currency,
          r.corrected ? "CORRECTED" : "",
          r.name,
          r.display_name,
          r.tin_type ?? "",
          r.tin_last4 ?? "",
          r.tax_classification ?? "",
          r.address?.line1 ?? "",
          r.address?.line2 ?? "",
          r.address?.city ?? "",
          r.address?.region ?? "",
          r.address?.postalCode ?? "",
          r.address?.country ?? "",
          ...form.boxes.map((box) => amounts[box.key] ?? ""),
        ]
          .map(csvCell)
          .join(","),
      );
    }

    const filename = `${filing.form_type}-${filing.tax_year}-transmittal-${await businessToday(orgId)}.csv`;
    return new NextResponse(lines.join("\n") + "\n", {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  },
});
