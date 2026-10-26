import "server-only";

import { runRecordFlows } from "@openbooks/engine/flows/module";
import {
  IntercompanyError,
  linkIntercompanyDocuments,
  livePairOf,
  loadIntercompanyPairDetail,
  planIntercompanyCounterpart,
  type PairDetail,
} from "@openbooks/engine/intercompany";
import { db } from "@openbooks/engine/platform/db";
import { sql } from "drizzle-orm";
import { DocumentEditError } from "@openbooks/engine/records/document-edit-policy";
import { can, type Authz } from "./authz";
import { createDocument, DocumentCreateConflict, isDocKindEnabled } from "./documents";
import { createPermission } from "./document-kinds";
import { draftDocumentId } from "./order-cycle";
import { createOrder } from "../app/api/_order/create";

/** The refusal an order writer answered, checked for status before parsing. */
async function refusalText(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const message =
    body && typeof body === "object" ? (body as { error?: unknown; message?: unknown }) : null;
  const text =
    typeof message?.error === "string"
      ? message.error
      : typeof message?.message === "string"
        ? message.message
        : null;
  return text && text.trim() ? text : `the order writer answered ${response.status}`;
}

/**
 * Generate the mirror of an intercompany document in the other entity and
 * pair the two.
 *
 * The plan (counterpart kind, entity, representing party, lines at the same
 * prices and currency) comes from the intercompany engine; the document is
 * written by the native writer for its kind — the order create kernel for a
 * purchase or sales order, the shared document writer for a bill, invoice or
 * credit — so the counterpart passes every validation, scope check, number
 * allocation and audit an operator's own save would. It is created as a
 * draft: the receiving entity reviews and posts it through its own
 * lifecycle and approvals. The generation is idempotent: the counterpart's
 * identity derives from the source document, so a retry after a lost
 * response finds the same draft and completes the pairing.
 */
export async function generateIntercompanyCounterpart(
  authz: Authz,
  documentId: string,
): Promise<PairDetail> {
  const orgId = authz.user.orgId;
  const plan = await planIntercompanyCounterpart(orgId, authz.allowedSubsidiaryIds, documentId);
  // The same grant the native create route for the counterpart kind requires.
  const permission =
    plan.pairKind === "order"
      ? plan.targetKind === "purchase_order"
        ? "purchase_orders.create"
        : "ar.create"
      : createPermission(plan.targetKind);
  if (!can(authz, permission)) {
    throw new IntercompanyError(
      `creating the counterpart requires the ${permission} permission`,
      422,
    );
  }
  const key = draftDocumentId(orgId, `intercompany-counterpart:${documentId}`);
  let counterpartId: string;
  if (plan.pairKind === "order") {
    const organization = (
      await db.execute<{ base_currency: string | null }>(
        sql`
      select base_currency from orgs where id = ${orgId}`,
        "objects",
      )
    )[0];
    if (!organization?.base_currency || organization.base_currency !== plan.currency) {
      throw new IntercompanyError(
        "The counterpart order must retain the source currency. Link an existing order in that currency from the pairing workspace.",
        422,
      );
    }
    const cfg =
      plan.targetKind === "purchase_order"
        ? {
            kind: "purchase_order" as const,
            createPerm: "purchase_orders.create",
            numberPrefix: "PO-",
          }
        : { kind: "sales_order" as const, createPerm: "ar.create", numberPrefix: "SO-" };
    const request = new Request("https://openbooks.invalid/intercompany/counterparts", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    const response = await createOrder(cfg, authz, request, {
      partyId: plan.targetPartyId,
      documentDate: plan.documentDate,
      memo: plan.memo,
      subsidiaryId: plan.targetSubsidiaryId,
      lines: plan.lines.map((line) => ({
        itemId: line.itemId,
        accountId: line.accountId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice ?? line.amount,
      })),
    });
    if (!response.ok) {
      throw new IntercompanyError(
        `the ${plan.targetKind.replace("_", " ")} could not be created: ${await refusalText(response)}`,
        response.status === 409 ? 409 : 422,
      );
    }
    counterpartId = key;
  } else {
    if (!(await isDocKindEnabled(orgId, plan.targetKind))) {
      throw new IntercompanyError(
        `${plan.targetKind.replace("_", " ")} documents are turned off in Company Settings → Features`,
        422,
      );
    }
    let created: Awaited<ReturnType<typeof createDocument>>;
    const body = {
      partyId: plan.targetPartyId,
      subsidiaryId: plan.targetSubsidiaryId,
      documentDate: plan.documentDate,
      currency: plan.currency,
      memo: plan.memo,
      referenceNumber: plan.source.documentNumber,
      lines: plan.lines.map((line) => ({
        accountId: line.accountId!,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        amount: line.amount,
      })),
    };
    try {
      created = await createDocument({
        orgId,
        userId: authz.user.id,
        kind: plan.targetKind,
        key,
        body,
        subsidiaryId: plan.targetSubsidiaryId,
        requestBody: { kind: plan.targetKind, ...body },
      });
    } catch (error) {
      if (error instanceof DocumentCreateConflict) {
        throw new IntercompanyError(
          "a different counterpart was already created for this document; review the existing draft",
          409,
        );
      }
      if (error instanceof DocumentEditError)
        throw new IntercompanyError(error.message, 422, undefined, error);
      throw error;
    }
    if (created.status === "created") {
      await runRecordFlows({ kind: "on_create", source: "ui" }, plan.targetKind, created.id, {
        orgId,
        userId: authz.user.id,
      });
      if (created.deferredUpdate) {
        await runRecordFlows(created.deferredUpdate, plan.targetKind, created.id, {
          orgId,
          userId: authz.user.id,
        });
      }
    }
    counterpartId = created.id;
  }
  // A concurrent generation may have paired the documents meanwhile.
  const existing = await livePairOf(db, orgId, documentId);
  if (existing) return loadIntercompanyPairDetail(orgId, existing.id, authz.allowedSubsidiaryIds);
  const [sellerDocumentId, buyerDocumentId] =
    plan.source.side === "seller"
      ? [plan.source.documentId, counterpartId]
      : [counterpartId, plan.source.documentId];
  return linkIntercompanyDocuments(orgId, authz.user.id, authz.allowedSubsidiaryIds, {
    sellerDocumentId,
    buyerDocumentId,
    origin: "generated",
  });
}
