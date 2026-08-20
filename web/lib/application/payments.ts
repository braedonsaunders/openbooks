import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { submitAndReleaseIfUngated } from "@openbooks/engine/src/flows/index.ts";
import {
  createPaymentDocument,
  loadPaymentDocument,
  PaymentError,
  postPaymentWithApplications,
  updateDraftPayment,
  type AllocationInput,
  type PaymentKind,
} from "@openbooks/engine/src/payments.ts";
import { PostingError } from "@openbooks/engine/src/posting.ts";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
} from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

type PaymentPatch = Parameters<typeof updateDraftPayment>[1];
type PaymentHeader = {
  kind: PaymentKind;
  status: string;
  subsidiaryId: string | null;
};

function paymentPermission(kind: PaymentKind): "ap.pay" | "ar.pay" {
  return kind === "vendor_payment" ? "ap.pay" : "ar.pay";
}

function isPaymentKind(kind: unknown): kind is PaymentKind {
  return kind === "vendor_payment" || kind === "customer_payment";
}

function paymentFailure(error: unknown): never {
  if (error instanceof PaymentError || error instanceof PostingError) {
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  throw error;
}

async function paymentHeader(
  context: ApplicationContext,
  documentId: string,
): Promise<PaymentHeader> {
  if (!isUuid(documentId)) throw invalidInput("documentId must be a UUID");
  const result = (await db.execute<PaymentHeader>(sql`
    select kind, status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${documentId}
       and org_id = ${context.authz.user.orgId}
       and kind in ('vendor_payment', 'customer_payment')
     limit 1
  `));
  const header = result.rows[0];
  if (!header) throw notFound("payment");
  assertSubsidiaryAccess(context, header.subsidiaryId);
  assertApplicationPermission(context, paymentPermission(header.kind));
  return header;
}

export async function createPayment(
  context: ApplicationContext,
  input: {
    kind: PaymentKind;
    partyId?: string | null;
    bankAccountId?: string | null;
    documentDate?: string;
    memo?: string | null;
    subsidiaryId?: string | null;
    currency?: string;
    fxRate?: string;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  if (!isPaymentKind(input.kind)) throw invalidInput("invalid payment kind");
  assertApplicationPermission(context, paymentPermission(input.kind));
  assertSubsidiaryAccess(context, input.subsidiaryId);
  const outcome = await executeIdempotent({
    context,
    operation: `payments.${input.kind}.create`,
    idempotencyKey: input.idempotencyKey,
    request: input,
    execute: async () => {
      try {
        const created = await createPaymentDocument({
          orgId: context.authz.user.orgId,
          kind: input.kind,
          createdBy: context.authz.user.id,
          partyId: input.partyId,
          bankAccountId: input.bankAccountId,
          documentDate: input.documentDate,
          memo: input.memo,
          subsidiaryId: input.subsidiaryId,
          currency: input.currency,
          fxRate: input.fxRate,
        });
        return await loadPaymentDocument(created.id, input.kind);
      } catch (error) {
        paymentFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function updatePayment(
  context: ApplicationContext,
  input: {
    documentId: string;
    patch: PaymentPatch;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  const header = await paymentHeader(context, input.documentId);
  const outcome = await executeIdempotent({
    context,
    operation: "payments.update",
    idempotencyKey: input.idempotencyKey,
    request: { documentId: input.documentId, patch: input.patch },
    execute: async () => {
      try {
        await updateDraftPayment(input.documentId, input.patch, context.authz.user.id);
        return await loadPaymentDocument(input.documentId, header.kind);
      } catch (error) {
        paymentFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function postPayment(
  context: ApplicationContext,
  input: {
    documentId: string;
    allocations?: AllocationInput[];
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: unknown }> {
  const header = await paymentHeader(context, input.documentId);
  const outcome = await executeIdempotent({
    context,
    operation: "payments.post",
    idempotencyKey: input.idempotencyKey,
    request: { documentId: input.documentId, allocations: input.allocations ?? null },
    execute: async () => {
      try {
        if (header.status === "draft") {
          const submission = await submitAndReleaseIfUngated(
            header.kind,
            input.documentId,
            context.authz.user.id,
          );
          if (submission.flowError) {
            throw new ApplicationError(
              "invalid_input",
              `approval could not be routed: ${submission.flowError}`,
              422,
            );
          }
          if (submission.gated) {
            return {
              status: "pending_approval",
              requestId: submission.runId,
              payment: await loadPaymentDocument(input.documentId, header.kind),
            };
          }
        } else if (header.status !== "approved") {
          throw invalidInput(
            `payment is ${header.status}; only an approved payment can be posted`,
          );
        }
        const posted = await postPaymentWithApplications(
          input.documentId,
          input.allocations,
          context.authz.user.id,
          context.source,
        );
        return {
          status: "posted",
          ...posted,
          payment: await loadPaymentDocument(input.documentId, header.kind),
        };
      } catch (error) {
        paymentFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}
