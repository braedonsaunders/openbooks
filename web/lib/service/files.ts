import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { ServiceError } from "@openbooks/engine/service/errors";
import { getServiceVisit } from "@openbooks/engine/service/reads";
import { lockVisit, visitFieldAuthority } from "@openbooks/engine/service/visits";
import { type AttachedFile, getFileBlob, listAttachments, uploadAndAttach } from "../file-cabinet";
import type { Authz } from "../authz";

/** Visit photos and attachments live in the File Cabinet, linked to the visit. */
export const SERVICE_VISIT_TARGET = "service_visits";

const PHOTO_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
export const MAX_VISIT_FILE_BYTES = 10 * 1024 * 1024;

export async function listVisitFiles(authz: Authz, visitId: string): Promise<AttachedFile[]> {
  const detail = await getServiceVisit({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    visitId,
  });
  return listAttachments(authz.user.orgId, SERVICE_VISIT_TARGET, detail.visit.id);
}

/**
 * Attach a photo or document to a visit. Anyone who may work the visit (its
 * booked technician, a dispatcher or a service manager) may add evidence;
 * the visit row is locked and the authority re-checked in the write.
 */
export async function attachVisitFile(
  authz: Authz,
  input: { visitId: string; filename: string; contentType: string; bytes: Buffer },
): Promise<AttachedFile> {
  if (!PHOTO_TYPES.has(input.contentType)) {
    throw new ServiceError("Attach a photo (JPEG, PNG, WebP or HEIC) or a PDF.", {
      code: "service_invalid",
    });
  }
  if (input.bytes.length === 0 || input.bytes.length > MAX_VISIT_FILE_BYTES) {
    throw new ServiceError("Attachments are at most 10 MB.", {
      code: "service_invalid",
      remedy: "Reduce the photo size and attach it again.",
    });
  }
  const actor = { orgId: authz.user.orgId, actorId: authz.user.id };
  return withOrgTransaction(actor.orgId, async () =>
    uploadAndAttach({
      orgId: actor.orgId,
      targetTable: SERVICE_VISIT_TARGET,
      targetId: input.visitId,
      filename: input.filename.slice(0, 200) || "photo",
      contentType: input.contentType,
      bytes: input.bytes,
      createdBy: actor.actorId,
      authorizeTarget: async () => {
        const visit = await lockVisit(actor.orgId, input.visitId);
        await visitFieldAuthority(actor, visit);
        if (visit.status === "cancelled")
          throw new ServiceError("A cancelled visit takes no attachments.", {
            status: 409,
            code: "service_invalid_transition",
          });
      },
    }),
  );
}

/**
 * The bytes of a file attached to a visit the caller may read. Reading the
 * visit is the authority: the file opens with the visit and confers no
 * cabinet-wide visibility.
 */
export async function readVisitFile(authz: Authz, visitId: string, fileId: string) {
  const detail = await getServiceVisit({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    visitId,
  });
  const linked = (
    await db.execute(
      sql`select 1 from file_attachments
     where org_id = ${authz.user.orgId} and target_table = ${SERVICE_VISIT_TARGET} and target_id = ${detail.visit.id} and file_id = ${fileId}
     union all
    select 1 from service_visit_signatures where org_id = ${authz.user.orgId} and visit_id = ${detail.visit.id} and signature_file_id = ${fileId}
     limit 1`,
      "objects",
    )
  )[0];
  if (!linked) return null;
  return getFileBlob(authz.user.orgId, fileId, {
    userId: authz.user.id,
    isAdmin: false,
    baseline: "viewer",
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  });
}
