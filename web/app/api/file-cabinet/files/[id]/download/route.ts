import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  hasVisibleAssetAttachment,
  listAttachedExpenseReportAccess,
} from "@openbooks/engine/records/file-cabinet-access";
import { isMaskedFileContentError } from "@/lib/file-storage";
import { getFileBlob } from "@/lib/file-cabinet";
import { blobResponse } from "@/lib/blob-response";
import { isUuid } from "@/lib/list-params";
import { can } from "@/lib/authz";
import { fileViewer } from "../../../lib";
import { notFound } from "@/lib/api/responses";
import { expenseAccess, expenseAccessAllows } from "@/lib/expense-access";
import { subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import type { Authz } from "@/lib/authz";

/** True when the file is attached to an expense report the caller may read. */
async function readsAttachedExpenseEvidence(gate: Authz, fileId: string): Promise<boolean> {
  const access = await expenseAccess(gate, "read");
  if (!access) return false;
  const reports = await listAttachedExpenseReportAccess(gate.user.orgId, fileId);
  return reports.some(
    (report) =>
      subsidiaryScopeAllows(gate.allowedSubsidiaryIds, report.subsidiaryId) &&
      expenseAccessAllows(access, report.partyId),
  );
}

export const runtime = "nodejs";

/**
 * Stream a file's bytes (inline, cache-revalidated — see blobResponse). A pinned
 * `?versionId=` is immutable and cached hard; the current-version URL uses ETag
 * revalidation so reopening a flyout is a 304, not a re-download.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    if (!gate) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    let viewer = fileViewer(gate);
    if (!can(gate, "documents.read") && (await readsAttachedExpenseEvidence(gate, id))) {
      // Evidence attached to an expense report the caller may read opens
      // with the report; it confers no cabinet-wide visibility.
      viewer = { ...viewer, baseline: "viewer" };
    } else if (!can(gate, "documents.read")) {
      if (!can(gate, "assets.read"))
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      const attachedAsset = await hasVisibleAssetAttachment(
        gate.user.orgId,
        id,
        gate.allowedSubsidiaryIds,
      );
      if (!attachedAsset) return notFound("record");
      // The attachment relation above limits this exception to evidence on an
      // asset the caller can see; it does not grant cabinet-wide visibility.
      viewer = {
        userId: gate.user.id,
        isAdmin: can(gate, "*"),
        baseline: "viewer",
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      };
    }

    const url = new URL(req.url);
    const versionId = url.searchParams.get("versionId") ?? undefined;
    if (versionId && !isUuid(versionId)) {
      return notFound("record");
    }
    // A masked-clone tombstone refuses by name. Per the repo rule, the error
    // body is produced from the checked refusal, never parsed out of a 500.
    let blob: Awaited<ReturnType<typeof getFileBlob>>;
    try {
      blob = await getFileBlob(gate.user.orgId, id, viewer, versionId);
    } catch (err) {
      if (isMaskedFileContentError(err)) {
        return apiErrorResponse(err, { safeStatus: 403 });
      }
      throw err;
    }
    if (!blob) return notFound("record");

    return blobResponse(req, blob, { immutable: versionId != null });
  },
});
