import { NextResponse } from "next/server";
import { settlementRateObservations } from "@openbooks/engine/payments/payment-queries";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { guardPermission } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";

export const runtime = "nodejs";

/** Tenant-owned spot observations available as immutable settlement evidence. */
export const GET = defineRoute({
  authorize: async ({ request }) => {
    const side = new URL(request.url).searchParams.get("side");
    if (side !== "ap" && side !== "ar")
      return NextResponse.json({ error: "side must be ap or ar" }, { status: 400 });
    return guardPermission(side === "ap" ? "ap.pay" : "ar.pay");
  },
  feature: {
    none: "Settlement-rate evidence is available only to the payment permission matching its AP or AR side.",
  },
  handler: async ({ request, authz: gate }) => {
    const url = new URL(request.url);
    const from = (url.searchParams.get("from") ?? "").toUpperCase();
    const targets = [
      ...new Set(
        (url.searchParams.get("to") ?? "")
          .split(",")
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    const date = url.searchParams.get("date") ?? "";
    if (
      !/^[A-Z]{3}$/.test(from) ||
      !targets.length ||
      targets.some((currency) => !/^[A-Z]{3}$/.test(currency))
    ) {
      return NextResponse.json(
        { error: "valid source and target currencies are required" },
        { status: 400 },
      );
    }
    if (!isIsoCalendarDate(date)) {
      return NextResponse.json({ error: "valid settlement date is required" }, { status: 400 });
    }

    const rates = await settlementRateObservations(gate.user.orgId, from, targets, date);

    return NextResponse.json({ rates });
  },
});
