import { z } from "zod";
import { randomUUID } from "node:crypto";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { applicationContextFromSession } from "../../../../../lib/application/context";
import {
  getDocumentSupplyEvidence,
  recordDocumentSupplyEvidence,
} from "../../../../../lib/application/document-actions";

export const runtime = "nodejs";

const EvidenceSchema = z.object({
  kind: z.enum([
    "billing_address",
    "ip_country",
    "card_bin_country",
    "bank_country",
    "sim_country",
    "ship_to",
  ]),
  country: z.string().min(2).max(2),
  source: z.string().min(1).max(40),
});

const PUTBodySchema = z.object({
  election: z.object({
    supplyKind: z.enum(["digital_service", "goods"]),
    customerKind: z.enum(["consumer", "business"]),
    // A credit memo names the posted invoice it corrects (null clears it);
    // absent leaves the relationship untouched.
    correctsDocumentId: uuidString().nullable().optional(),
  }),
  evidence: z.array(EvidenceSchema).max(6),
});

/**
 * Place-of-supply evidence on a draft sales document: read the collected
 * signals with the frozen verdict, or replace the election and signals in
 * one unit. Only derived country codes are stored — never raw IPs, PANs or
 * BINs. Posted documents refuse through the evidence guard.
 */
export const GET = defineRoute({
  permission: "ar.read",
  feature: "crossBorderTax",
  params: z.object({ id: uuidString() }),
  handler: async ({ authz, params, request }) => {
    try {
      return NextResponse.json(
        await getDocumentSupplyEvidence(
          applicationContextFromSession(
            authz,
            "api",
            request.headers.get("x-request-id") || randomUUID(),
          ),
          params.id,
        ),
      );
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});

export const PUT = defineRoute({
  permission: "ar.create",
  feature: "crossBorderTax",
  params: z.object({ id: uuidString() }),
  body: PUTBodySchema,
  handler: async ({ authz, params, body, request }) => {
    try {
      const result = await recordDocumentSupplyEvidence(
        applicationContextFromSession(
          authz,
          "api",
          request.headers.get("x-request-id") || randomUUID(),
        ),
        { documentId: params.id, ...body },
      );
      const { kind: _kind, ...saved } = result;
      return NextResponse.json({ ok: true, ...saved });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
