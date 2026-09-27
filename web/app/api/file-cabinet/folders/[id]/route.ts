import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  deleteFolder,
  getFolder,
  patchFolder,
  purgeFolder,
} from "../../../../../lib/file-cabinet";
import { isUuid } from "../../../../../lib/list-params";
import { can } from "../../../../../lib/authz";
import { fileViewer, requireFolderAccess } from "../../lib";
import { notFound } from "@/lib/api/responses";
const patchBodySchema0 = z
  .strictObject({
    parentId: z.string().uuid("parentId must be a valid id").nullable().optional(),
    name: z.string().trim().min(1, "name cannot be empty").max(255).optional(),
    isPrivate: z.boolean().optional(),
    isInactive: z.boolean().optional(),
  })
  .superRefine((body, context) => {
    if (body.isInactive !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["isInactive"],
        message: "folder trash state cannot be changed with PATCH — use DELETE to trash the subtree or the restore action to restore it",
      });
    }
    if (!Object.keys(body).some((key) => key !== "isInactive")) {
      context.addIssue({ code: "custom", message: "provide a folder field to update" });
    }
  });

export { runtime } from "@/lib/api/route";

/** Get a single folder. Private-folder visibility applies: a folder hidden
 *  behind someone else's private boundary reads as not found. */
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
    const folder = await getFolder(gate.user.orgId, id, fileViewer(gate));
    if (!folder)
      return notFound("record");
    return NextResponse.json({ folder });
  },
});

/** Update folder metadata. Trash and restore operate on the complete subtree. */
export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  body: patchBodySchema0,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    // Editing a folder (rename/move/flags) needs Manager on it.
    const access = await requireFolderAccess(gate, id, "manager");
    if (access) return access;

    const body = routeBody;
    if (!body)
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    if (Object.prototype.hasOwnProperty.call(body, "isInactive")) {
      return NextResponse.json(
        {
          error:
            "folder trash state cannot be changed with PATCH — use DELETE to trash the subtree or the restore action to restore it",
        },
        { status: 400 },
      );
    }

    const patch: {
      parentId?: string | null;
      name?: string;
      isPrivate?: boolean;
    } = {};
    if (typeof body.parentId === "string" || body.parentId === null) {
      // A missing key is "no move". An unchanged value is also no move: compare
      // against the stored (unmasked) parent, so a pure rename never re-gates
      // the destination — and a parent the viewer cannot see can never drag a
      // rename out to the cabinet root.
      const current = await getFolder(gate.user.orgId, id);
      if (!current || (body.parentId ?? null) !== current.parentId) {
        if (typeof body.parentId === "string") {
          // Moving also needs Editor+ on the destination parent.
          const destGate = await requireFolderAccess(
            gate,
            body.parentId,
            "editor",
          );
          if (destGate) return destGate;
        } else if (!can(gate, "documents.manage") && !can(gate, "*")) {
          // Moving to the cabinet root publishes the subtree to every
          // documents.read user: the same bar as creating a top-level folder.
          return NextResponse.json({ error: "forbidden" }, { status: 403 });
        }
        patch.parentId = body.parentId;
      }
    }
    if (typeof body.name === "string" && body.name.trim()) {
      patch.name = body.name.trim();
    }
    if (typeof body.isPrivate === "boolean") patch.isPrivate = body.isPrivate;
    if (Object.keys(patch).length > 0) {
      const result = await patchFolder(
        gate.user.orgId,
        id,
        patch,
        gate.user.id,
        {
          actorId: gate.user.id,
          viewer: fileViewer(gate),
        },
      );
      if (!result.ok) {
        const status =
          result.reason === "not found"
            ? 404
            : result.reason === "forbidden"
              ? 403
              : 400;
        return NextResponse.json({ error: result.reason }, { status });
      }
    }
    return NextResponse.json({ ok: true });
  },
});

/** Delete a folder (fails if it contains attached files). */
export const DELETE = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    // Deleting a folder needs Manager on it.
    const access = await requireFolderAccess(gate, id, "manager");
    if (access) return access;
    const purge = new URL(req.url).searchParams.get("purge") === "1";
    const audit = { actorId: gate.user.id, viewer: fileViewer(gate) };
    const result = purge
      ? await purgeFolder(gate.user.orgId, id, audit)
      : await deleteFolder(gate.user.orgId, id, audit);
    if (!result.ok) {
      if (result.reason === "retained") {
        return NextResponse.json(
          {
            error: "retained_evidence_cannot_be_trashed",
            detail:
              "this folder contains retained evidence for a posted or active record, a live payment artifact, or a lifecycle-governed HR document; release those files through their owning records first",
          },
          { status: 409 },
        );
      }
      const status =
        result.reason === "not found"
          ? 404
          : result.reason === "forbidden"
            ? 403
            : result.reason === "system"
              ? 400
              : 409;
      return NextResponse.json({ error: result.reason }, { status });
    }
    return NextResponse.json({ ok: true });
  },
});
