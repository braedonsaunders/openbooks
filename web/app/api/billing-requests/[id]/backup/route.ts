import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { readBillingRequestInvoice } from "@openbooks/engine/projects/billing-requests-read";
import type { Authz } from "@/lib/authz";
import { rendererUnavailableResponse } from "@/lib/api/pdf-renderer";
import { isUuid } from "@/lib/list-params";
import { pdfResponse, safeName } from "@/lib/export";
import {
  assembleInvoiceBackup,
  loadInvoiceBackup,
  InvoiceBackupImmutableError,
  InvoiceBackupNotFoundError,
  InvoiceBackupSourceAccessError,
  type BackupType,
} from "@/lib/invoice-backup";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** POST — assemble + persist the backup package for the request's invoice. */
async function legacyPOST(gate: Authz, id: string) {
  if (!isUuid(id)) return notFound("record");
  const req = await readBillingRequestInvoice(db, gate.user.orgId, id, gate.allowedSubsidiaryIds);
  if (!req) return notFound("record");
  if (!req.invoice_document_id)
    return NextResponse.json(
      { error: "This request has no invoice to back up yet" },
      { status: 422 },
    );
  try {
    const result = await assembleInvoiceBackup(
      gate.user.orgId,
      gate.user.id,
      req.invoice_document_id,
      req.backup_type as BackupType,
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json({ fileId: result.fileId, pageCount: result.pageCount });
  } catch (e) {
    if (e instanceof InvoiceBackupNotFoundError) return notFound("record");
    if (e instanceof InvoiceBackupSourceAccessError)
      return apiErrorResponse(e, { safeStatus: 403 });
    if (e instanceof InvoiceBackupImmutableError) return apiErrorResponse(e, { safeStatus: 422 });
    const rendererRefusal = rendererUnavailableResponse(e);
    if (rendererRefusal) return rendererRefusal;
    return apiErrorResponse(e);
  }
}

/**
 * GET — stream the stored backup PDF. A read never assembles: generating the
 * packet persists a PDF plus file-cabinet evidence, which a reader holding
 * only ar.read must not be able to create.
 */
async function legacyGET(gate: Authz, id: string) {
  if (!isUuid(id)) return notFound("record");
  const req = await readBillingRequestInvoice(db, gate.user.orgId, id, gate.allowedSubsidiaryIds);
  if (!req) return notFound("record");
  if (!req.invoice_document_id)
    return NextResponse.json({ error: "No invoice to back up" }, { status: 404 });
  try {
    const backup = await loadInvoiceBackup(
      gate.user.orgId,
      req.invoice_document_id,
      gate.allowedSubsidiaryIds,
    );
    if (!backup) {
      return NextResponse.json(
        {
          error:
            "No backup has been generated for this invoice yet — generate it from the billing request first",
        },
        { status: 404 },
      );
    }
    return pdfResponse(backup.bytes, safeName(backup.filename));
  } catch (e) {
    if (e instanceof InvoiceBackupNotFoundError) return notFound("record");
    if (e instanceof InvoiceBackupSourceAccessError)
      return apiErrorResponse(e, { safeStatus: 403 });
    throw e;
  }
}

export const POST = defineRoute({
  permission: "ar.create",
  feature: "projects",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => legacyPOST(authz, params.id),
});

export const GET = defineRoute({
  permission: "ar.read",
  feature: "projects",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => legacyGET(authz, params.id),
});
