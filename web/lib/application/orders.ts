import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  ConversionError,
  CONVERSION_TARGETS,
  convertOrder,
  createOrderDraft,
  type OrderKind,
} from "../order-cycle";
import { isFeatureEnabled } from "../features";
import { isDocumentRevisionToken } from "@openbooks/engine/src/records/revision.ts";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

export const ORDER_TYPE_KIND = {
  quotes: "quote",
  "sales-orders": "sales_order",
  "purchase-orders": "purchase_order",
} as const;

export type OrderTypeKey = keyof typeof ORDER_TYPE_KIND;

function orderWritePermission(kind: OrderKind): string {
  return kind === "purchase_order" ? "ap.create" : "ar.create";
}

function conversionFailure(error: unknown): never {
  if (error instanceof ConversionError) {
    const code = error.status === 404
      ? "not_found"
      : error.status === 409
        ? "conflict"
        : error.status === 403
          ? "forbidden"
          : "invalid_input";
    throw new ApplicationError(code, error.message, error.status, {
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
  }
  throw error;
}

/** Empty commercial-order draft — same writer as the New Order drawer. */
export async function createApplicationOrder(
  context: ApplicationContext,
  input: { kind: OrderKind; idempotencyKey: string },
): Promise<{ replayed: boolean; result: { id: string; documentNumber: string } }> {
  assertApplicationPermission(context, orderWritePermission(input.kind));
  if (!(await isFeatureEnabled(context.authz.user.orgId, "orders"))) throw notFound("order");
  const outcome = await executeIdempotent({
    context,
    operation: "order.create",
    idempotencyKey: input.idempotencyKey,
    request: { kind: input.kind },
    execute: async () => {
      try {
        const draft = await createOrderDraft(context.authz.user.orgId, context.authz.user.id, input.kind);
        return { id: draft.id, documentNumber: draft.document_number };
      } catch (error) {
        if (error instanceof Error && error.message === "Orders feature is disabled") {
          throw notFound("order");
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

/** Convert an issued order — same writer as the order-cycle convert action. */
export async function convertApplicationOrder(
  context: ApplicationContext,
  input: {
    documentId: string;
    targetKind: string;
    expectedUpdatedAt?: string;
    creditOverrideReason?: string;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; result: { id: string; documentNumber: string; kind: string } }> {
  const sourceKind = await sourceOrderKind(context.authz.user.orgId, input.documentId);
  assertApplicationPermission(context, orderWritePermission(sourceKind));
  if (!(await isFeatureEnabled(context.authz.user.orgId, "orders"))) throw notFound("order");
  const allowed = CONVERSION_TARGETS[sourceKind] ?? [];
  if (!allowed.some((target) => target.kind === input.targetKind)) {
    throw invalidInput(`Cannot convert a ${sourceKind} into ${input.targetKind}`);
  }
  if (input.expectedUpdatedAt !== undefined && !isDocumentRevisionToken(input.expectedUpdatedAt)) {
    throw invalidInput("expectedUpdatedAt must be the document revision token from GET");
  }
  const outcome = await executeIdempotent({
    context,
    operation: "order.convert",
    idempotencyKey: input.idempotencyKey,
    request: {
      documentId: input.documentId,
      targetKind: input.targetKind,
      expectedUpdatedAt: input.expectedUpdatedAt ?? null,
      creditOverrideReason: input.creditOverrideReason ?? null,
    },
    execute: async () => {
      try {
        return await convertOrder(
          context.authz.user.orgId,
          context.authz.user.id,
          input.documentId,
          input.targetKind,
          {
            creditOverrideReason: input.creditOverrideReason,
            expectedUpdatedAt: input.expectedUpdatedAt,
          },
        );
      } catch (error) {
        conversionFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

async function sourceOrderKind(orgId: string, documentId: string): Promise<OrderKind> {
  const row = (await db.execute<{ kind: string }>(sql`
    select kind from documents
     where id = ${documentId} and org_id = ${orgId}
       and kind in ('quote', 'sales_order', 'purchase_order')
  `)).rows[0];
  if (!row) throw notFound("order");
  return row.kind as OrderKind;
}
