import "server-only";
import { getServiceRequest } from "@openbooks/engine/service/reads";
import { saveServiceQuoteTerms } from "@openbooks/engine/service/quotes";
import { ServiceError } from "@openbooks/engine/service/errors";
import { subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import { createOrderDraft, OrderDraftError } from "../order-cycle";
import { applyOrderEdit, OrderEditError } from "../order-draft-edit";
import { orderEditServices } from "../../app/api/_order/handlers";
import { serviceActor } from "./authority";

const QUOTE_CONFIG = {
  kind: "quote",
  readPerm: "estimates.read",
  createPerm: "estimates.create",
} as const;

/**
 * Start a quote for a service request: a native draft estimate for the
 * request's customer in the request's legal entity, carrying service terms
 * (no deposit, no add-ons) until the dispatcher sets them. Lines, pricing,
 * tax and approval stay in the native estimate editor. The key makes a
 * retried click return the same estimate.
 */
export async function startServiceQuote(
  authz: Authz,
  input: { requestId: string; idempotencyKey: string },
): Promise<{ quoteDocumentId: string; documentNumber: string; replayed: boolean }> {
  const actor = serviceActor(authz);
  if (!(await isFeatureEnabled(actor.orgId, "orders"))) {
    throw new ServiceError("Quotes are estimates, and Orders is switched off.", {
      status: 409,
      code: "service_configuration_missing",
      remedy: "Enable Orders on Company Settings → Features to quote service work.",
    });
  }
  if (!can(authz, "estimates.create")) {
    throw new ServiceError("Quoting needs permission to create estimates.", {
      status: 403,
      code: "service_forbidden",
      remedy: "Ask an administrator for estimate entry, or have a dispatcher prepare the quote.",
    });
  }
  const detail = await getServiceRequest({ ...actor, requestId: input.requestId });
  const request = detail.request;
  if (!subsidiaryScopeAllows(authz.allowedSubsidiaryIds, request.subsidiaryId)) {
    throw new ServiceError("This request belongs to a legal entity outside your access.", {
      status: 404,
      code: "service_not_found",
    });
  }
  if (!["new", "assessment_scheduled", "assessed", "quoted"].includes(request.status)) {
    throw new ServiceError("A closed request takes no new quote.", {
      status: 409,
      code: "service_invalid_transition",
      remedy: "Open the job created from the request, or take a new request.",
    });
  }
  let draft: Awaited<ReturnType<typeof createOrderDraft>>;
  try {
    draft = await createOrderDraft(
      actor.orgId,
      actor.actorId,
      "quote",
      input.idempotencyKey,
      request.subsidiaryId,
    );
  } catch (error) {
    if (error instanceof OrderDraftError)
      throw new ServiceError(error.message, { status: 409, code: "service_refused", cause: error });
    throw error;
  }
  if (!draft.replayed) {
    const response = await applyOrderEdit(
      {
        orgId: actor.orgId,
        userId: actor.actorId,
        user: authz.user,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        permissions: authz.permissions,
        services: orderEditServices,
      },
      QUOTE_CONFIG,
      draft.id,
      { partyId: request.customerPartyId, memo: `${request.requestNumber} — ${request.title}` },
    ).catch((error: unknown) => {
      if (error instanceof OrderEditError) {
        const body = (error.body ?? {}) as { error?: unknown };
        throw new ServiceError(typeof body.error === "string" ? body.error : error.message, {
          status: error.status,
          code: "service_refused",
          cause: error,
        });
      }
      throw error;
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        remedy?: unknown;
      } | null;
      throw new ServiceError(
        typeof body?.error === "string"
          ? body.error
          : "The estimate could not take the request’s customer.",
        {
          status: response.status,
          code: "service_refused",
          remedy:
            typeof body?.remedy === "string"
              ? body.remedy
              : "Open the draft estimate and set its customer.",
        },
      );
    }
  }
  await saveServiceQuoteTerms({
    ...actor,
    quoteDocumentId: draft.id,
    requestId: request.id,
    depositBasis: "none",
    depositValue: "0",
    optionalLineIds: [],
  }).catch((error: unknown) => {
    // A replayed draft already carries its terms; anything else is the refusal.
    if (
      draft.replayed &&
      error instanceof ServiceError &&
      error.code === "service_invalid_transition"
    )
      return null;
    throw error;
  });
  return {
    quoteDocumentId: draft.id,
    documentNumber: draft.document_number,
    replayed: draft.replayed,
  };
}
