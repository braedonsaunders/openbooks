import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyStandaloneCredits,
  creditSettlementState,
  unapplyCreditSettlement,
} from "@openbooks/engine/payments/credit-settlement";
import {
  creditApplicationDocumentScope,
  creditApplicationSettlementScope,
  paymentPartyScope,
} from "@openbooks/engine/payments/payment-queries";
import { CreditApplicationConflictError } from "@openbooks/engine/payments-core/payment-errors";
import { exactMoney, isoDate, uuidId } from "@/lib/api/json";
import { guardPermission, guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { paymentErrorResponse } from "../lib";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";

export const runtime = "nodejs";

/**
 * Settle a posted credit memo — or a payment's unapplied cash: a receipt's
 * on-account credit or a vendor prepayment — against posted open items with
 * NO cash.
 *
 * A credit that fully covers an invoice had no workflow at all: posting a
 * payment refuses zero cash allocations, so the balance stayed open on both
 * documents. This is the cash-free path — it writes the same `applications`
 * ledger a receipt writes and posts no journal entry, because netting two open
 * items on one control account moves no money.
 */

const applyBody = z.object({
  partyId: uuidId,
  side: z.enum(["ap", "ar"]),
  appliedOn: isoDate(),
  credits: z
    .array(
      z.object({
        fromLineId: uuidId,
        toLineId: uuidId,
        amount: exactMoney(),
        sourceDocumentId: uuidId,
      }),
    )
    .min(1, "select at least one credit to apply"),
});

// The caller states which side it is releasing so the permission can be
// resolved before any tenant read. The settlement's ACTUAL side is checked
// against it below, inside the org scope — otherwise an AR-only user could
// name 'ar' and release an AP credit.
const releaseBody = z.object({ applicationId: uuidId, side: z.enum(["ap", "ar"]) });

async function guardParty(gate: Authz, partyId: string): Promise<NextResponse | null> {
  const party = await paymentPartyScope(gate.user.orgId, partyId);
  if (!party) return notFound("record");
  // Null-subsidiary parties are org-wide, like every other party reader here.
  return guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true });
}

/**
 * What a posted credit has settled and what is left to apply. The panel reads
 * this so its remaining figure and the engine's open-balance check come from
 * the same rows.
 */
async function getCreditApplications(req: Request, gate: Authz) {
  const url = new URL(req.url);
  const side = url.searchParams.get("side");
  if (side !== "ap" && side !== "ar") {
    return NextResponse.json({ error: "side must be ap or ar" }, { status: 400 });
  }
  const documentId = url.searchParams.get("documentId") ?? "";
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: "documentId is required" }, { status: 400 });
  }
  // Bind the document to the side it claims before reading its settlements:
  // an AR reader must not learn what a vendor credit paid.
  const doc = await creditApplicationDocumentScope(gate.user.orgId, documentId, side);
  if (!doc) return notFound("record");
  const documentDenied = guardSubsidiaryScope(gate, doc.subsidiaryId);
  if (documentDenied) return documentDenied;
  if (doc.partyId) {
    const denied = await guardParty(gate, doc.partyId);
    if (denied) return denied;
  }
  try {
    return NextResponse.json({
      state: await creditSettlementState(gate.user.orgId, documentId, gate.allowedSubsidiaryIds),
    });
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return notFound("record");
    throw error;
  }
}

async function applyCredits(req: Request, gate: Authz, body: z.infer<typeof applyBody>) {
  // One key, one settlement: a retried submit (network timeout, double
  // click) must resolve to the settlement it already wrote, never a second
  // one beside it — the deferred app_check_open trigger only stops a retry
  // that overdraws the credit, so a partial application duplicated silently.
  const idempotencyKey = req.headers.get("Idempotency-Key") ?? "";
  if (!isUuid(idempotencyKey)) {
    return NextResponse.json(
      {
        error:
          "an Idempotency-Key header with a UUID is required, so a retried apply cannot settle twice",
      },
      { status: 400 },
    );
  }
  const { partyId, side, appliedOn, credits } = body;
  const denied = await guardParty(gate, partyId);
  if (denied) return denied;
  try {
    const result = await applyStandaloneCredits(
      gate.user.orgId,
      gate.user.id,
      {
        partyId,
        side,
        appliedOn,
        credits,
        idempotencyKey,
      },
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ScopeNotFoundError) return notFound("record");
    // A reused key that cannot replay is a conflict with a named remedy, not
    // a validation failure: the operator must reload and review what settled.
    if (e instanceof CreditApplicationConflictError) {
      return apiErrorResponse(e, { safeStatus: 409 });
    }
    return paymentErrorResponse(e);
  }
}

/**
 * Release a live credit settlement, reopening both balances. This is the arm
 * behind the void refusal "unapply them before voiding"; cash applications are
 * refused by name and pointed at the void that owns their evidence.
 */
async function releaseCredits(gate: Authz, body: z.infer<typeof releaseBody>) {
  const { applicationId, side } = body;

  // Now inside the caller's org: confirm the settlement really is the side the
  // caller was gated on, and that its party is in scope. A mismatch is the
  // tenant-opaque 404 every other id lookup here returns — naming the other
  // side's kind would itself disclose it.
  const row = await creditApplicationSettlementScope(gate.user.orgId, applicationId);
  const actualSide =
    row?.kind === "vendor_credit" || row?.kind === "vendor_payment"
      ? "ap"
      : row?.kind === "customer_credit" || row?.kind === "customer_payment"
        ? "ar"
        : null;
  if (!row || actualSide !== side) {
    return notFound("record");
  }
  if (row.partyId) {
    const denied = await guardParty(gate, row.partyId);
    if (denied) return denied;
  }
  try {
    const result = await unapplyCreditSettlement(
      gate.user.orgId,
      gate.user.id,
      applicationId,
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ScopeNotFoundError) return notFound("record");
    return paymentErrorResponse(e);
  }
}

const sidePermission = async (request: Request, verb: "read" | "pay") => {
  let side: unknown;
  try {
    const value: unknown =
      request.method === "GET"
        ? new URL(request.url).searchParams.get("side")
        : ((await request.clone().json()) as { side?: unknown }).side;
    side = value;
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  if (side !== "ap" && side !== "ar") {
    return NextResponse.json({ error: "side must be ap or ar" }, { status: 400 });
  }
  return guardPermission(side === "ap" ? `ap.${verb}` : `ar.${verb}`);
};
const creditAppFeature = {
  none: "The selected AP or AR permission gates each credit-application operation.",
} as const;
export const GET = defineRoute({
  authorize: ({ request }) => sidePermission(request, "read"),
  feature: creditAppFeature,
  handler: async ({ request, authz }) => getCreditApplications(request, authz),
});
export const POST = defineRoute({
  authorize: ({ request }) => sidePermission(request, "pay"),
  feature: creditAppFeature,
  body: applyBody,
  handler: async ({ request, authz, body }) => applyCredits(request, authz, body),
});
export const DELETE = defineRoute({
  authorize: ({ request }) => sidePermission(request, "pay"),
  feature: creditAppFeature,
  body: releaseBody,
  handler: async ({ authz, body }) => releaseCredits(authz, body),
});
