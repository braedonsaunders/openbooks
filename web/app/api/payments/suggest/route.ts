import { NextResponse } from "next/server";
import { z } from "zod";
import { paymentPartyScope, suggestApplications } from "@openbooks/engine/payments/payment-queries";
import { getAuthz, guardPermission, guardSubsidiaryScope } from "@/lib/authz";
import { exactMoney, uuidId } from "@/lib/api/json";
import { paymentErrorResponse } from "../lib";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";

export const runtime = "nodejs";

const suggestBody = z.object({
  partyId: z
    .string({ error: "partyId is required" })
    .refine((v) => uuidId.safeParse(v).success, "partyId is required"),
  amount: exactMoney("a numeric amount is required"),
  side: z.enum(["ap", "ar"], { error: "side must be ap or ar" }),
  currency: z.string({ error: "currency is required" }).regex(/^[A-Z]{3}$/, "currency is required"),
  reference: z.string().nullable().optional(),
});

/** Automated cash application: suggest how an amount settles a party's open items. */
export const POST = defineRoute({
  authorize: async ({ request }) => {
    let side: unknown;
    try {
      side = ((await request.clone().json()) as { side?: unknown }).side;
    } catch {
      /* body parser provides the malformed-body refusal */
    }
    if (side !== "ap" && side !== "ar") {
      const authz = await getAuthz();
      return authz ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return guardPermission(side === "ap" ? "ap.pay" : "ar.pay");
  },
  feature: {
    none: "Application suggestions require the payment permission matching their AP or AR side.",
  },
  body: suggestBody,
  handler: async ({ authz: gate, body }) => {
    // The suggestion discloses a party's open items — the party is the record
    // boundary. Null-subsidiary parties are org-wide (mirrors the party lists).
    const party = await paymentPartyScope(gate.user.orgId, body.partyId);
    if (!party) return notFound("record");
    const scopeDenied = guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true });
    if (scopeDenied) return scopeDenied;
    try {
      const suggestion = await suggestApplications(body.partyId, body.amount, body.side, {
        reference: body.reference ?? null,
        orgId: gate.user.orgId,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        sourceCurrency: body.currency,
      });
      return NextResponse.json(suggestion);
    } catch (e) {
      return paymentErrorResponse(e);
    }
  },
});
