import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import {
  loadPaymentDocument,
  paymentDocumentScope,
} from "@openbooks/engine/payments/payment-queries";
import { PaymentRevisionConflictError } from "@openbooks/engine/payments-core/payment-errors";
import { updateDraftPayment } from "@openbooks/engine/payments/payment-documents";
import { type PaymentKind } from "@openbooks/engine/payments/payment-contracts";
import { deleteDocument, DeleteError } from "@openbooks/engine/ledger/document-delete";
import { assertAnyPermission, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { can, getAuthz, guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import {
  DocumentEditError,
  requireDocumentEditRevision,
} from "@openbooks/engine/records/document-edit-policy";
import { exactMoney, isoDate, nullableUuidId, uuidId } from "@/lib/api/json";
import { paymentErrorResponse, assertAllocationTargetsInScope, paymentPermission } from "../lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** One open-item application on a draft payment (engine AllocationInput). */
const allocationInput = z.object({
  openLineId: z.string().min(1),
  /** Amount consumed from the payment/credit source, in the payment currency. */
  sourceTransactionAmount: exactMoney(),
  /** Amount extinguished on the invoice/bill, in the target open-item currency. */
  targetTransactionAmount: exactMoney(),
  /** Optional independently saved target carrying value, revalidated at posting. */
  targetBaseAmount: exactMoney().optional(),
  /** Target-currency units for one source-currency unit. Required cross-currency. */
  settlementRate: z.string().min(1),
  settlementRateSource: z.enum(["same_currency", "provider", "manual", "contractual", "imported"]),
  /** Bank advice, contract, provider observation, or import evidence reference. */
  settlementRateReference: z.string(),
  settlementFxRateId: nullableUuidId.optional(),
});

const paymentPatchBody = z.object({
  /** Optimistic concurrency token from documents.revision_seq (exact form). */
  expectedUpdatedAt: z.string().optional(),
  partyId: nullableUuidId.optional(),
  bankAccountId: nullableUuidId.optional(),
  documentDate: isoDate().optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  withholdingAuthorisation: z.string().trim().max(100).nullable().optional(),
  withholdingAuthorisedAmount: exactMoney().nullable().optional(),
  // Explicit settlement rate into the owning entity's functional currency:
  // the same strict rate/source/reason/pair/date object the invoice/bill
  // editor carries. Null clears recorded evidence; absent preserves it.
  explicitFx: z
    .object({
      rate: z.string(),
      source: z.string(),
      reason: z.string(),
      fromCurrency: z.string(),
      toCurrency: z.string(),
      rateDate: isoDate(),
    })
    .strict()
    .nullable()
    .optional(),
  allocations: z.array(allocationInput).optional(),
  // Cash received beyond the applications (customer receipts only).
  onAccountAmount: exactMoney().optional(),
  // Credit-memo applications (engine CreditAllocationInput). The engine
  // validates endpoints, signs, and capacity at save and at posting; the
  // route only shapes them. Without this field a receipt can never apply a
  // credit memo through the product API.
  creditAllocations: z
    .array(
      z.object({
        fromLineId: uuidId,
        toLineId: uuidId,
        amount: exactMoney(),
        sourceDocumentId: uuidId,
      }),
    )
    .optional(),
  // Stored-value tenders (customer receipts only): fresh gift-card codes or
  // already-resolved echoes (account id — the code is shown once at issue).
  // The engine resolves codes and re-verifies every tender at save and
  // posting; the route only shapes them.
  storedValueTenders: z
    .array(
      z.union([
        z.object({ code: z.string().min(1).max(64), amount: exactMoney() }),
        z.object({ accountId: uuidId, amount: exactMoney() }),
      ]),
    )
    .optional(),
});

/** Resolve the document's kind, then gate on ap.pay / ar.pay accordingly.
 *  Permission before existence (canonical shape 4 in
 *  engine/src/organization/subsidiary-scope.ts): a caller holding neither
 *  ap.pay nor ar.pay learns nothing — existing and missing ids answer the
 *  same uniform 404. Subsidiary scope is enforced here too, so every verb
 *  (GET/PATCH/DELETE) inherits the same fail-closed record boundary. */
async function gateForDocument(
  id: string,
  orgId: string | null,
): Promise<{ authz: Authz; kind: PaymentKind } | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isUuid(id)) return notFound("record");
  try {
    assertAnyPermission((permission) => can(authz, permission), ["ap.pay", "ar.pay"]);
  } catch (error) {
    if (error instanceof ScopeNotFoundError) {
      return notFound("record");
    }
    throw error;
  }
  const payment = await paymentDocumentScope(orgId ?? authz.user.orgId, id);
  if (!payment) return notFound("record");
  const denied = guardSubsidiaryScope(authz, payment.subsidiaryId);
  if (denied) return denied;
  const kind = payment.kind;
  // Wrong-direction callers learn nothing either: the kind-specific
  // permission fails closed with the same uniform 404, so an ap.pay-only
  // caller cannot distinguish an existing customer receipt from a missing id.
  const perm = paymentPermission(kind);
  if (!can(authz, perm)) {
    return notFound("record");
  }
  return { authz, kind };
}

async function getPayment(id: string, authz: Authz, kind: PaymentKind) {
  const payment = await loadPaymentDocument(id, kind, authz.user.orgId, authz.allowedSubsidiaryIds);
  if (!payment) return notFound("record");
  return NextResponse.json(payment);
}

/** Autosave for draft payments: header fields + open-item allocations.
 *
 * Saves are fenced by the document's exact revision: the caller echoes the
 * `updated_at` token it loaded, and the engine writes only when that token
 * still matches the row locked FOR UPDATE inside the write transaction — so
 * two concurrent saves can never silently overwrite one another. */
async function patchPayment(id: string, authz: Authz, body: z.infer<typeof paymentPatchBody>) {
  // Mandatory optimistic-concurrency evidence — same contract as /api/documents/[id].
  let expectedRevision: string;
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt);
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return apiErrorResponse(e);
    }
    throw e;
  }
  const allocationTargetsDenied = await assertAllocationTargetsInScope(authz, [
    ...(body.allocations ?? []).map((a) => a.openLineId),
    ...(body.creditAllocations ?? []).flatMap((a) => [a.fromLineId, a.toLineId]),
  ]);
  if (allocationTargetsDenied) return allocationTargetsDenied;

  try {
    const payment = await updateDraftPayment(
      id,
      {
        partyId: body.partyId,
        bankAccountId: body.bankAccountId,
        documentDate: body.documentDate,
        referenceNumber: body.referenceNumber,
        memo: body.memo,
        withholdingAuthorisation: body.withholdingAuthorisation,
        withholdingAuthorisedAmount: body.withholdingAuthorisedAmount,
        explicitFx: body.explicitFx,
        allocations: body.allocations,
        onAccountAmount: body.onAccountAmount,
        creditAllocations: body.creditAllocations,
        storedValueTenders: body.storedValueTenders,
      },
      authz.user.id,
      authz.user.orgId,
      // The OCC token is route-level evidence; it never enters the engine's
      // financial patch shape. The engine also rechecks this scope under the
      // locked payment row; the earlier lookup is only a permission gate.
      {
        expectedRevision,
        // Forward the authoritative scope as-is: explicit null is the
        // unrestricted grant, and omitting it would fail closed above.
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      },
    );
    return NextResponse.json(payment);
  } catch (e) {
    // The engine fence fired under the row lock: someone saved first.
    if (e instanceof PaymentRevisionConflictError) {
      return apiErrorResponse(e, { safeStatus: 409 });
    }
    if (e instanceof ScopeNotFoundError) return notFound("record");
    return paymentErrorResponse(e);
  }
}

/** Delete a payment/receipt (guarded: open period, no live applications). */
async function deletePayment(id: string, authz: Authz) {
  try {
    await deleteDocument(id, authz.user.id, authz.user.orgId, {
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ScopeNotFoundError) return notFound("record");
    if (e instanceof DeleteError) return apiErrorResponse(e);
    throw e;
  }
}

const paymentParams = z.object({ id: z.string() });
const authorizedKinds = new WeakMap<Authz, PaymentKind>();
const authorizePaymentRecord = async ({ params }: { request: Request; params: unknown }) => {
  const id = (params as { id?: string } | undefined)?.id ?? "";
  const gate = await gateForDocument(id, null);
  if (gate instanceof NextResponse) return gate;
  authorizedKinds.set(gate.authz, gate.kind);
  return gate.authz;
};
const paymentFeature = {
  none: "The handler resolves AP or AR payment authority from the organization-scoped payment record.",
} as const;
export const GET = defineRoute({
  authorize: authorizePaymentRecord,
  feature: paymentFeature,
  params: paymentParams,
  handler: async ({ params, authz }) => {
    const kind = authorizedKinds.get(authz);
    if (!kind) return notFound("record");
    return getPayment((params as { id: string }).id, authz, kind);
  },
});
export const PATCH = defineRoute({
  authorize: authorizePaymentRecord,
  feature: paymentFeature,
  params: paymentParams,
  body: paymentPatchBody,
  opaque: {
    expectedUpdatedAt: "Payment updates are partial; the handler requires the concurrency token.",
    partyId:
      "Payment updates are partial; each supplied field is validated before the service call.",
    bankAccountId:
      "Payment updates are partial; each supplied field is validated before the service call.",
    documentDate:
      "Payment updates are partial; each supplied field is validated before the service call.",
    referenceNumber:
      "Payment updates are partial; each supplied field is validated before the service call.",
    memo: "Payment updates are partial; each supplied field is validated before the service call.",
    withholdingAuthorisation:
      "Payment updates are partial; each supplied field is validated before the service call.",
    withholdingAuthorisedAmount:
      "Payment updates are partial; each supplied field is validated before the service call.",
    explicitFx:
      "Payment updates are partial; each supplied field is validated before the service call.",
    allocations:
      "Payment updates are partial; each supplied field is validated before the service call.",
    onAccountAmount:
      "Payment updates are partial; each supplied field is validated before the service call.",
    creditAllocations:
      "Payment updates are partial; each supplied field is validated before the service call.",
    storedValueTenders:
      "Payment updates are partial; each supplied field is validated before the service call.",
  },
  invalidBodyStatus: 422,
  handler: async ({ params, authz, body }) =>
    patchPayment((params as { id: string }).id, authz, body),
});
export const DELETE = defineRoute({
  authorize: authorizePaymentRecord,
  feature: paymentFeature,
  params: paymentParams,
  handler: async ({ params, authz }) => deletePayment((params as { id: string }).id, authz),
});
