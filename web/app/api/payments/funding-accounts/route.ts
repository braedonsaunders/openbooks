import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { paymentErrorResponse } from "../lib";
import { receiptFundingAccountOptions } from "@openbooks/engine/payments/documents";
import { can } from "@/lib/authz";
import { isoDate, uuidId } from "@/lib/api/json";

const fundingQuery = z.object({
  kind: z.enum(["customer_payment", "vendor_payment"]),
  subsidiaryId: uuidId,
  currency: z.string().regex(/^[A-Z]{3}$/),
  date: isoDate(),
});
export const GET = defineRoute({
  public: "session",
  handler: async ({ request, authz }) => {
    const parsed = fundingQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      return NextResponse.json(
        { error: "valid receipt scope, currency and date are required" },
        { status: 422 },
      );
    const query = parsed.data;
    if (!can(authz, query.kind === "customer_payment" ? "ar.pay" : "ap.pay"))
      return NextResponse.json({ error: "record not found" }, { status: 404 });
    try {
      return NextResponse.json({
        accounts: await receiptFundingAccountOptions({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          kind: query.kind,
          subsidiaryId: query.subsidiaryId,
          currency: query.currency,
          onDate: query.date,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        }),
      });
    } catch (error) {
      return paymentErrorResponse(error);
    }
  },
});
