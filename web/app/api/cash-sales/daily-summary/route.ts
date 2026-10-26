import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createDocument } from "@openbooks/engine/documents/write";
import { loadDocument } from "@openbooks/engine/ledger/document-service";
import { DocumentEditError } from "@openbooks/engine/records/document-edit-policy";
import { runRecordFlows } from "@openbooks/engine/flows/run";
import { DocumentCreateConflict } from "../../../../lib/documents.ts";
import type { DocumentEditInput } from "@openbooks/engine/ledger/document-input";
import { getAuthz, can, guardSubsidiaryScope, subsidiariesInScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { notFound } from "@/lib/api/responses";
import { customFieldViewerFor } from "../../../../lib/custom-fields";
import { apiErrorResponse } from "@/lib/api/error-response";
import { activeOperatingSubsidiaryIds } from "@/lib/record-scope-reads";

const SummaryLineSchema = z.object({
  accountId: uuidString(),
  amount: z.string().min(1),
  description: z.string().max(500).nullable().optional(),
  quantity: z.string().nullable().optional(),
  unitPrice: z.string().nullable().optional(),
  taxCodeId: uuidString().nullable().optional(),
  taxGroupId: uuidString().nullable().optional(),
});

const SummaryTenderSchema = z.object({
  kind: z.enum(["cash", "card", "bank_transfer", "wallet", "gateway", "stored_value", "other"]),
  methodLabel: z.string().max(120).nullable().optional(),
  accountId: uuidString().nullable().optional(),
  storedValueAccountId: uuidString().nullable().optional(),
  amount: z.string().min(1),
  reference: z.string().max(120).nullable().optional(),
  externalRef: z.string().max(120).nullable().optional(),
  tipAmount: z.string().nullable().optional(),
  feeAmount: z.string().nullable().optional(),
});

const POSTBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  partyId: uuidString().nullable().optional(),
  subsidiaryId: uuidString().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  lines: z.array(SummaryLineSchema).min(1).max(500),
  tenders: z.array(SummaryTenderSchema).min(1).max(60),
  closeout: z
    .object({
      overShort: z.string().nullable().optional(),
      serverPartyId: uuidString().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const runtime = "nodejs";

/**
 * Daily summary entry: one form (date, totals by tax code and category,
 * tenders, tips, fees, over/short) creating the day's cash sale as a draft
 * through the native document path — line tax from the named tax codes
 * (per-line, like the drawer), tenders into document_tenders, the close-out
 * onto custom.closeout. The cashier reviews and posts it from the drawer.
 */
export const POST = defineRoute({
  public: "session",
  body: POSTBodySchema,
  handler: async ({ request: req, body: routeBody }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const user = authz.user;
    if (!can(authz, "cash_sales.create")) {
      return NextResponse.json({ error: "missing permission: cash_sales.create" }, { status: 403 });
    }
    if (!(await isDocKindEnabled(user.orgId, "cash_sale"))) {
      return notFound("record");
    }
    if (
      routeBody.subsidiaryId !== undefined &&
      routeBody.subsidiaryId !== null &&
      !subsidiariesInScope(authz, [routeBody.subsidiaryId])
    ) {
      return NextResponse.json({ error: "invalid subsidiary" }, { status: 422 });
    }
    const headerKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
    if (headerKey !== "" && !isUuid(headerKey)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    let subsidiaryId: string | null = null;
    if (routeBody.subsidiaryId !== undefined) {
      subsidiaryId = routeBody.subsidiaryId;
    } else {
      const roots = await activeOperatingSubsidiaryIds(user.orgId);
      subsidiaryId =
        roots.find((id) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(id)) ??
        null;
      if (!subsidiaryId) {
        return NextResponse.json({ error: "no_available_subsidiary" }, { status: 409 });
      }
    }
    const body: DocumentEditInput = {
      documentDate: routeBody.date,
      partyId: routeBody.partyId ?? undefined,
      memo: routeBody.memo ?? undefined,
      ...(routeBody.currency ? { currency: routeBody.currency } : {}),
      subsidiaryId,
      custom: {
        tenders: routeBody.tenders.map((tender) => ({
          kind: tender.kind,
          ...(tender.methodLabel ? { methodLabel: tender.methodLabel } : {}),
          ...(tender.accountId ? { accountId: tender.accountId } : {}),
          ...(tender.storedValueAccountId
            ? { storedValueAccountId: tender.storedValueAccountId }
            : {}),
          amount: tender.amount,
          ...(tender.reference ? { reference: tender.reference } : {}),
          ...(tender.externalRef ? { externalRef: tender.externalRef } : {}),
          ...(tender.tipAmount ? { tipAmount: tender.tipAmount } : {}),
          ...(tender.feeAmount ? { feeAmount: tender.feeAmount } : {}),
        })),
        ...(routeBody.closeout
          ? {
              closeout: {
                ...(routeBody.closeout.overShort
                  ? { overShort: routeBody.closeout.overShort }
                  : {}),
                ...(routeBody.closeout.serverPartyId
                  ? { serverPartyId: routeBody.closeout.serverPartyId }
                  : {}),
              },
            }
          : {}),
      },
      lines: routeBody.lines.map((line) => ({
        accountId: line.accountId,
        amount: line.amount,
        ...(line.description ? { description: line.description } : {}),
        ...(line.quantity ? { quantity: line.quantity } : {}),
        ...(line.unitPrice ? { unitPrice: line.unitPrice } : {}),
        ...(line.taxCodeId ? { taxCodeId: line.taxCodeId } : {}),
        ...(line.taxGroupId ? { taxGroupId: line.taxGroupId } : {}),
      })),
    };
    let created: Awaited<ReturnType<typeof createDocument>>;
    try {
      created = await createDocument({
        orgId: user.orgId,
        userId: user.id,
        kind: "cash_sale",
        key: headerKey !== "" ? headerKey : randomUUID(),
        body,
        subsidiaryId,
        requestBody: { kind: "cash_sale", ...body },
        customFieldViewer: customFieldViewerFor(authz),
      });
    } catch (e) {
      if (e instanceof DocumentCreateConflict) {
        return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
      }
      if (e instanceof DocumentEditError) {
        if (e.status === 404 && e.message === "not found") return notFound("record");
        return apiErrorResponse(e, {
          details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : undefined,
        });
      }
      throw e;
    }
    if (created.status === "replayed") {
      const doc = await loadDocument(created.id, user.orgId, customFieldViewerFor(authz));
      if (!doc) return notFound("record");
      const replayDenied = guardSubsidiaryScope(authz, doc.doc.subsidiary_id as string | null);
      if (replayDenied) return replayDenied;
      return NextResponse.json(doc);
    }
    await runRecordFlows({ kind: "on_create", source: "ui" }, "cash_sale", created.id, {
      orgId: user.orgId,
      userId: user.id,
    });
    if (created.deferredUpdate) {
      await runRecordFlows(created.deferredUpdate, "cash_sale", created.id, {
        orgId: user.orgId,
        userId: user.id,
      });
    }
    const doc = await loadDocument(created.id, user.orgId, customFieldViewerFor(authz));
    if (!doc) return notFound("record");
    const createdDenied = guardSubsidiaryScope(authz, doc.doc.subsidiary_id as string | null);
    if (createdDenied) return createdDenied;
    return NextResponse.json(doc, { status: 201 });
  },
});
