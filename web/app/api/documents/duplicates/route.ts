import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { defineRoute } from "@/lib/api/route";
import { getAuthz } from "@/lib/authz";
import { canReadDocumentKind } from "@/lib/flow-subject-authz";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@/lib/list-params";
import { canonicalDecimal, compareDecimal } from "@openbooks/engine/src/money/exact-decimal.ts";

export const runtime = "nodejs";

const querySchema = z
  .object({
    kind: z.enum(["customer_invoice", "vendor_bill"]),
    partyId: z.string().uuid(),
    documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    total: z.string().min(1).max(32),
    referenceNumber: z.string().max(200).optional(),
  })
  .strict();

/**
 * Possible duplicates for a confirm-before-save warning: non-voided
 * documents of the same kind for the same party, document date and total —
 * plus the same vendor reference for bills. A warning, never a refusal:
 * the drawer shows the matches and the operator saves anyway to create
 * another. Matches stay inside the caller's subsidiary scope.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = querySchema.safeParse(params);
    if (!parsed.success || !isUuid(parsed.data.partyId)) {
      return NextResponse.json({ error: "kind, partyId, documentDate and total are required" }, { status: 400 });
    }
    const { kind, partyId, documentDate, total, referenceNumber } = parsed.data;
    if (!canReadDocumentKind(authz, kind)) return notFound("record");
    const amount = canonicalDecimal(total, 4);
    if (amount === null || compareDecimal(amount, "0") <= 0) {
      return NextResponse.json({ error: "total must be a positive exact decimal" }, { status: 400 });
    }
    // Bills match on the vendor reference too; a blank reference matches
    // nothing rather than warning on every same-total bill.
    const reference = referenceNumber?.trim() ?? "";
    if (kind === "vendor_bill" && !reference) return NextResponse.json({ duplicates: [] });
    const rows = (await db.execute<{ id: string; documentNumber: string }>(sql`
      select id, document_number as "documentNumber" from documents
       where org_id = ${authz.user.orgId} and kind = ${kind}
         and status <> 'voided'
         and party_id = ${partyId}
         and document_date = ${documentDate}::date
         and total = ${amount}
         ${kind === "vendor_bill" ? sql`and nullif(btrim(reference_number), '') = ${reference}` : sql``}
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by document_date desc, id
       limit 5`)).rows;
    return NextResponse.json({
      duplicates: rows.map((row) => ({ id: row.id, documentNumber: row.documentNumber })),
    });
  },
});
