import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  correctReceiptQuantity,
  correctReceiptRemainder,
} from "@openbooks/engine/inventory/receipt-void-dependents";
import {
  EInvoiceConfigurationError,
  issueNativeEInvoice,
  type EInvoiceProfileKey,
} from "@openbooks/engine/einvoice";
import {
  billMatchCandidates,
  matchVendorBillLines,
} from "@openbooks/engine/payables/vendor-bill-matching";
import { recordSupplyEvidence } from "@openbooks/engine/tax";
import { applyDocumentPromotion } from "../promotions";
import { isFeatureEnabled } from "../features";
import { isDocKindEnabled } from "../documents";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
  type ApplicationContext,
} from "./context";
import { notFound } from "./errors";
import { readEInvoiceSubject } from "../einvoice/document-reads";

export async function listVendorBillMatchCandidates(
  context: ApplicationContext,
  documentId: string,
) {
  assertApplicationPermission(context, "ap.read");
  const document = await documentScope(context, documentId);
  if (document.kind !== "vendor_bill") throw notFound("vendor bill");
  return billMatchCandidates(context.authz.user.orgId, documentId);
}

export async function getDocumentSupplyEvidence(context: ApplicationContext, documentId: string) {
  assertApplicationPermission(context, "ar.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "crossBorderTax"))) {
    throw notFound("document");
  }
  const scopedDocument = await documentScope(context, documentId);
  if (scopedDocument.kind !== "customer_invoice" && scopedDocument.kind !== "customer_credit") {
    throw notFound("document");
  }
  const document = (
    await db.execute<{
      custom: { crossBorder?: unknown; crossBorderSupply?: unknown } | null;
    }>(
      sql`
      select custom from documents
       where org_id = ${context.authz.user.orgId} and id = ${documentId}
    `,
      "objects",
    )
  )[0];
  if (!document) throw notFound("document");
  const evidence = await db.execute<{
    kind: string;
    countryCode: string;
    source: string;
    observedOn: string | null;
  }>(
    sql`
    select kind, country_code as "countryCode", source, observed_on::text as "observedOn"
      from document_supply_evidence
     where org_id = ${context.authz.user.orgId} and document_id = ${documentId}
     order by kind, source
  `,
    "objects",
  );
  const corrected =
    (
      await db.execute<{ id: string; number: string }>(
        sql`
        select corrected.id, corrected.document_number as number
          from document_links link
          join documents corrected
            on corrected.org_id = link.org_id and corrected.id = link.to_document_id
         where link.org_id = ${context.authz.user.orgId}
           and link.from_document_id = ${documentId}
           and link.link_type = 'corrects'
         limit 1
      `,
        "objects",
      )
    )[0] ?? null;
  return {
    election: document.custom?.crossBorder ?? null,
    verdict: document.custom?.crossBorderSupply ?? null,
    evidence,
    correctedDocument: corrected,
  };
}

async function documentScope(context: ApplicationContext, documentId: string) {
  const row = (
    await db.execute<{ id: string; kind: string; status: string; subsidiaryId: string | null }>(
      sql`
      select id, kind, status, subsidiary_id as "subsidiaryId"
        from documents
       where id = ${documentId} and org_id = ${context.authz.user.orgId}
       limit 1
    `,
      "objects",
    )
  )[0];
  if (!row || !(await isDocKindEnabled(context.authz.user.orgId, row.kind)))
    throw notFound("document");
  assertSubsidiaryAccess(context, row.subsidiaryId);
  return row;
}

export async function applyDocumentPromotionAction(
  context: ApplicationContext,
  input: { documentId: string; code?: string; promotionId?: string },
) {
  assertApplicationPermission(context, "ar.create");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "promotions")))
    throw notFound("promotion");
  const document = await documentScope(context, input.documentId);
  return {
    ...(await applyDocumentPromotion({
      orgId: context.authz.user.orgId,
      actorId: context.authz.user.id,
      documentId: input.documentId,
      code: input.code,
      promotionId: input.promotionId,
      channelId: null,
      allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
    })),
    kind: document.kind,
  };
}

export async function correctPurchaseReceiptRemainder(
  context: ApplicationContext,
  input: {
    documentId: string;
    reason: string;
    date?: string;
    lines?: { receiptLineId: string; correctedQuantity: string }[];
  },
) {
  assertApplicationPermission(context, "goods_receipts.create");
  const document = await documentScope(context, input.documentId);
  if (document.kind !== "purchase_receipt") throw notFound("goods receipt");
  if (await isFeatureEnabled(context.authz.user.orgId, "inventory")) {
    assertApplicationPermission(context, "items.reverse");
  }
  const args = {
    orgId: context.authz.user.orgId,
    actorId: context.authz.user.id,
    receiptId: input.documentId,
    reason: input.reason,
    date: input.date,
  };
  const result = input.lines
    ? correctReceiptQuantity({ ...args, lines: input.lines })
    : correctReceiptRemainder(args);
  return { ...(await result), kind: document.kind };
}

export async function recordDocumentSupplyEvidence(
  context: ApplicationContext,
  input: {
    documentId: string;
    election: {
      supplyKind: "digital_service" | "goods";
      customerKind: "consumer" | "business";
      correctsDocumentId?: string | null;
    };
    evidence: {
      kind:
        | "billing_address"
        | "ip_country"
        | "card_bin_country"
        | "bank_country"
        | "sim_country"
        | "ship_to";
      country: string;
      source: string;
    }[];
  },
) {
  assertApplicationPermission(context, "ar.create");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "crossBorderTax"))) {
    throw notFound("document");
  }
  const document = await documentScope(context, input.documentId);
  if (document.kind !== "customer_invoice" && document.kind !== "customer_credit") {
    throw notFound("document");
  }
  return {
    ...(await withOrgTransaction(context.authz.user.orgId, () =>
      recordSupplyEvidence(
        db,
        context.authz.user.orgId,
        input.documentId,
        input,
        context.authz.user.id,
      ),
    )),
    kind: document.kind,
  };
}

export async function matchVendorBillLinesAction(
  context: ApplicationContext,
  input: {
    documentId: string;
    expectedUpdatedAt?: string;
    matches: { billLineId: string; purchaseOrderLineId: string }[];
  },
) {
  assertApplicationPermission(context, "ap.read");
  const document = await documentScope(context, input.documentId);
  if (document.kind !== "vendor_bill") throw notFound("vendor bill");
  assertApplicationPermission(context, "ap.create");
  const result = await matchVendorBillLines({
    orgId: context.authz.user.orgId,
    billId: input.documentId,
    actorId: context.authz.user.id,
    matches: input.matches,
    expectedUpdatedAt: input.expectedUpdatedAt,
  });
  return { ok: true, ...result };
}

export async function issueDocumentEInvoice(
  context: ApplicationContext,
  input: { documentId: string; profile: EInvoiceProfileKey; buyerReference?: string | null },
) {
  assertApplicationPermission(context, "documents.manage");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "einvoicing"))) throw notFound("document");
  const document = await documentScope(context, input.documentId);
  const subject = await readEInvoiceSubject(
    db,
    {
      orgId: context.authz.user.orgId,
      allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
    },
    input.documentId,
  );
  if (!subject) throw notFound("document");
  const issued = await issueNativeEInvoice(
    {
      orgId: context.authz.user.orgId,
      actorId: context.authz.user.id,
      allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
    },
    input.documentId,
    { profile: input.profile, buyerReference: input.buyerReference },
    async (invoice) => {
      const [values, store, render, templateValues] = await Promise.all([
        import("../pdf-templates/values"),
        import("../pdf-templates/store"),
        import("../pdf-templates/render"),
        import("../pdf-templates/einvoice"),
      ]);
      const template = await store.resolvePdfTemplate(
        context.authz.user.orgId,
        document.kind,
        null,
        await store.loadRecordDesignatedTemplateName(
          context.authz.user.orgId,
          document.kind,
          input.documentId,
        ),
      );
      const record = await values.loadPdfRecordValues(
        document.kind,
        context.authz.user.orgId,
        input.documentId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!template || !record) {
        throw new EInvoiceConfigurationError(
          "The native invoice PDF design or invoice values are unavailable. Review PDF Templates before issuing this invoice.",
        );
      }
      templateValues.assertEInvoicePdfDesign(template, invoice);
      return render.mergeAndPrintPdf(
        template,
        await templateValues.eInvoicePdfValues(invoice, record.values),
      );
    },
  );
  return {
    ok: true,
    id: issued.id,
    fileName: issued.fileName,
    sha256: issued.sha256,
    downloadUrl: `/api/documents/${input.documentId}/einvoice?issued=${issued.id}`,
    href: `/ar/invoices?doc=${encodeURIComponent(input.documentId)}`,
  };
}
