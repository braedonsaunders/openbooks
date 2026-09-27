import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { inDbTransaction } from "@openbooks/engine/src/platform/db.ts";
import {
  deleteFile,
  getFile,
  isRetainedFileEvidence,
  moveFile,
  purgeFile,
  renameFile,
} from "../../../../../lib/file-cabinet";
import { isUuid } from "../../../../../lib/list-params";
import { fileViewer, requireFileAccess, requireFolderAccess } from "../../lib";
import { notFound } from "@/lib/api/responses";
const patchBodySchema0 = z
  .strictObject({
    name: z.string().trim().min(1, "name cannot be empty").max(255).optional(),
    folderId: z.string().uuid("folderId must be a valid id").optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "provide a file name or folderId to update");

export { runtime } from "@/lib/api/route";

/** Abort a multi-verb file edit so the shared transaction rolls everything back. */
class FilePatchAbort extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FilePatchAbort";
    this.status = status;
  }
}

/** Get file details (metadata + versions + attachment links). */
export const GET = defineRoute({
  permission: "documents.read",
  feature: {
    none: "This documents surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    const file = await getFile(gate.user.orgId, id, fileViewer(gate));
    if (!file)
      return notFound("record");
    return NextResponse.json({ file });
  },
});

/** Rename or move a file. */
export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  body: patchBodySchema0,
  handler: async ({ request: req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    // Editing (rename/move) a file needs Editor+ on it.
    const gateAccess = await requireFileAccess(gate, id, "editor");
    if (gateAccess) return gateAccess;

    const body = routeBody;
    if (!body)
      return NextResponse.json({ error: "invalid body" }, { status: 400 });

    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : null;
    const folderId = typeof body.folderId === "string" ? body.folderId : null;
    // Every refusal is decided BEFORE anything commits: the rename and the move
    // below share one transaction, so a refused move can never leave a rename
    // behind (and a refused rename never reaches the move).
    if (folderId !== null) {
      // Moving also needs Editor+ on the destination folder.
      const destGate = await requireFolderAccess(gate, folderId, "editor");
      if (destGate) return destGate;
    }
    if (name === null && folderId === null)
      return NextResponse.json({ ok: true });
    try {
      await inDbTransaction(async (tx) => {
        const audit = {
          actorId: gate.user.id,
          executor: tx,
          viewer: fileViewer(gate),
        };
        if (name !== null) {
          // The verb commits the rename and its attributable audit atomically.
          const ok = await renameFile(
            gate.user.orgId,
            id,
            name,
            gate.user.id,
            audit,
          );
          if (!ok) throw new FilePatchAbort(404, "not found");
        }
        if (folderId !== null) {
          const ok = await moveFile(
            gate.user.orgId,
            id,
            folderId,
            gate.user.id,
            audit,
          );
          if (!ok) throw new FilePatchAbort(400, "cannot move file");
        }
      });
    } catch (error) {
      if (error instanceof FilePatchAbort) {
        return apiErrorResponse(error);
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  },
});

/** Trash a file (soft-delete), or permanently delete it with `?purge=1`. */
export const DELETE = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    // Deleting needs Manager on the file.
    const gateAccess = await requireFileAccess(gate, id, "manager");
    if (gateAccess) return gateAccess;
    const purge = new URL(req.url).searchParams.get("purge") === "1";
    // The verb commits the mutation and its attributable audit atomically (for
    // purge, before any post-commit S3 deletion).
    const audit = { actorId: gate.user.id, viewer: fileViewer(gate) };
    if (purge) {
      const outcome = await purgeFile(gate.user.orgId, id, audit);
      if (outcome === "retained") {
        return NextResponse.json(
          { error: "retained_evidence_cannot_be_purged" },
          { status: 409 },
        );
      }
      if (outcome === "forbidden")
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      if (outcome === "not_found")
        return notFound("record");
      return NextResponse.json({ ok: true });
    }
    const ok = await deleteFile(gate.user.orgId, id, audit);
    if (!ok) {
      // Enforcement happened inside the trash transaction; this read only
      // names the refusal. Retained evidence is released through the owning
      // record's lifecycle (void/supersede/delete), never by hiding the file.
      if (await isRetainedFileEvidence(gate.user.orgId, id)) {
        return NextResponse.json(
          {
            error: "retained_evidence_cannot_be_trashed",
            detail:
              "this file is retained evidence for a posted or active record, a live payment artifact, or a lifecycle-governed HR document; release it through the owning record first",
          },
          { status: 409 },
        );
      }
      return notFound("record");
    }
    return NextResponse.json({ ok: true });
  },
});
