import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import {
  EInvoiceConfigurationError,
  EInvoiceRefusal,
  EINVOICE_PROFILES,
  isEInvoiceProfileKey,
  issueNativeEInvoice,
  loadNativeEInvoice,
  validateEInvoice,
  type EInvoiceProfileKey,
} from "@openbooks/engine/einvoice";
import { defineRoute } from "@/lib/api/route";
import { can } from "@/lib/authz";
import { isDocKindEnabled } from "@/lib/documents";
import { contentDisposition } from "@/lib/export";
import { rendererUnavailableResponse } from "@/lib/api/pdf-renderer";
import { loadPdfRecordValues } from "@/lib/pdf-templates/values";
import { loadRecordDesignatedTemplateName, resolvePdfTemplate } from "@/lib/pdf-templates/store";
import { mergeAndPrintPdf } from "@/lib/pdf-templates/render";
import { assertEInvoicePdfDesign, eInvoicePdfValues } from "@/lib/pdf-templates/einvoice";
import {
  listEInvoiceArchives,
  readEInvoiceArchive,
  readEInvoiceSubject,
} from "@/lib/einvoice/document-reads";

export const runtime = "nodejs";
const params = z.object({ id: uuidString() });
const profileKey = z
  .string()
  .refine(
    (value): value is EInvoiceProfileKey => isEInvoiceProfileKey(value),
    "Choose a supported e-invoice profile.",
  );
const issueBody = z
  .object({
    profile: profileKey,
    buyerReference: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();
const querySchema = z
  .object({
    profile: profileKey.optional(),
    buyerReference: z.string().trim().max(200).optional(),
    validate: z.enum(["1"]).optional(),
    issued: uuidString().optional(),
  })
  .strict();

function refusal(error: unknown): NextResponse | null {
  const renderer = rendererUnavailableResponse(error);
  if (renderer) return renderer;
  if (error instanceof EInvoiceRefusal)
    return NextResponse.json({ error: error.message, findings: error.findings }, { status: 422 });
  if (error instanceof EInvoiceConfigurationError)
    return NextResponse.json({ error: error.message }, { status: 422 });
  return null;
}

/** Archive downloads are independent of current seller or recipient configuration. */
export const GET = defineRoute({
  permission: "ar.read",
  feature: "einvoicing",
  params,
  handler: async ({ request, authz, params: { id } }) => {
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success)
      return NextResponse.json(
        { error: query.error.issues[0]?.message ?? "Invalid e-invoice request." },
        { status: 400 },
      );
    return withOrgTransaction(authz.user.orgId, async () => {
      const tx = db;
      const document = await readEInvoiceSubject(
        tx,
        { orgId: authz.user.orgId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
        id,
        { lock: true },
      );
      if (!document || !(await isDocKindEnabled(authz.user.orgId, document.kind)))
        throw new ScopeNotFoundError();
      if (query.data.issued) {
        const archive = await readEInvoiceArchive(tx, authz.user.orgId, id, query.data.issued);
        if (!archive) throw new ScopeNotFoundError();
        const extension = archive.mediaType === "application/pdf" ? "pdf" : "xml";
        return new NextResponse(new Uint8Array(archive.content), {
          headers: {
            "Content-Type": archive.mediaType,
            "Content-Disposition": contentDisposition(
              "attachment",
              archive.fileName.replace(/\.(pdf|xml)$/i, ""),
              extension,
            ),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-EInvoice-SHA256": archive.sha256,
          },
        });
      }
      const archives = await listEInvoiceArchives(tx, authz.user.orgId, id);
      const metadata = {
        profiles: Object.values(EINVOICE_PROFILES).map(({ key, label, hybridPdf }) => ({
          key,
          label,
          hybridPdf,
        })),
        configuredProfile: document.configuredProfile,
        buyerReference: document.buyerReference,
        canIssue: document.status === "posted" && can(authz, "documents.manage"),
        archives,
      };
      if (!query.data.validate) return NextResponse.json(metadata);
      try {
        const loaded = await loadNativeEInvoice(
          tx,
          {
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          },
          id,
          {
            profile: query.data.profile,
            buyerReference:
              query.data.buyerReference === undefined
                ? undefined
                : query.data.buyerReference || null,
          },
        );
        const findings = validateEInvoice(loaded.invoice);
        if (EINVOICE_PROFILES[loaded.invoice.profile].hybridPdf) {
          const template = await resolvePdfTemplate(
            authz.user.orgId,
            document.kind,
            null,
            await loadRecordDesignatedTemplateName(authz.user.orgId, document.kind, id),
          );
          if (!template)
            throw new EInvoiceConfigurationError(
              "Choose an active invoice design in PDF Templates before issuing Factur-X / ZUGFeRD.",
            );
          assertEInvoicePdfDesign(template, loaded.invoice);
        }
        return NextResponse.json({
          ...metadata,
          profile: loaded.invoice.profile,
          findings,
          valid: !findings.some((finding) => finding.severity === "fatal"),
        });
      } catch (error) {
        if (error instanceof EInvoiceConfigurationError)
          return NextResponse.json({
            ...metadata,
            valid: false,
            error: error.message,
            findings: [],
          });
        throw error;
      }
    });
  },
});

/** The native issuance command seals and audits the original bytes before download. */
export const POST = defineRoute({
  permission: "documents.manage",
  feature: "einvoicing",
  params,
  body: issueBody,
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const document = await readEInvoiceSubject(
        db,
        { orgId: authz.user.orgId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
        id,
      );
      if (!document || !(await isDocKindEnabled(authz.user.orgId, document.kind)))
        throw new ScopeNotFoundError();
      const issued = await issueNativeEInvoice(
        {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        },
        id,
        body,
        async (invoice) => {
          const template = await resolvePdfTemplate(
            authz.user.orgId,
            document.kind,
            null,
            await loadRecordDesignatedTemplateName(authz.user.orgId, document.kind, id),
          );
          const record = await loadPdfRecordValues(
            document.kind,
            authz.user.orgId,
            id,
            authz.allowedSubsidiaryIds,
          );
          if (!template || !record)
            throw new EInvoiceConfigurationError(
              "The native invoice PDF design or invoice values are unavailable. Review PDF Templates before issuing this invoice.",
            );
          assertEInvoicePdfDesign(template, invoice);
          return mergeAndPrintPdf(template, await eInvoicePdfValues(invoice, record.values));
        },
      );
      return NextResponse.json(
        {
          id: issued.id,
          fileName: issued.fileName,
          sha256: issued.sha256,
          downloadUrl: `/api/documents/${id}/einvoice?issued=${issued.id}`,
        },
        { status: 201 },
      );
    } catch (error) {
      const response = refusal(error);
      if (response) return response;
      throw error;
    }
  },
});
