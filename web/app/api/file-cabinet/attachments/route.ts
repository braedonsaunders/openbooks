import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  attachExisting,
  getFile,
  uploadAndAttach,
} from "../../../../lib/file-cabinet";
import { isUuid } from "../../../../lib/list-params";
import { can } from "../../../../lib/authz";
import {
  attachmentMutationRefusal,
  authorizeAttachmentTargetMutation,
} from "../lib";
import {
  attachmentReadPermission,
  attachmentTargetInScope,
  canMutateFiles,
  fileViewer,
  isAllowedContentType,
  isAttachableTargetTable,
  listVisibleAttachments,
  loadAttachmentTarget,
  MAX_BYTES,
} from "../lib";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  fileId: z.string().uuid("fileId must be a valid id"),
  targetId: z.string().uuid("targetId must be a valid id"),
  targetTable: z.string().refine(isAttachableTargetTable, "targetTable must be an attachable record type"),
});

export const runtime = "nodejs";

/** List files attached to a record (metadata only). */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const targetTable = url.searchParams.get("targetTable") ?? "";
    const targetId = url.searchParams.get("targetId") ?? "";
    if (!targetTable || !isUuid(targetId)) {
      return NextResponse.json(
        { error: "targetTable and targetId are required" },
        { status: 400 },
      );
    }
    if (!isAttachableTargetTable(targetTable)) {
      return NextResponse.json(
        { error: "unsupported targetTable" },
        { status: 422 },
      );
    }

    if (!gate)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const target = await loadAttachmentTarget(
      gate.user.orgId,
      targetTable,
      targetId,
    );
    if (!target || !attachmentTargetInScope(gate, target)) {
      return notFound("record");
    }
    const permission = attachmentReadPermission(targetTable, target.kind);
    if (!permission)
      return notFound("record");
    if (!can(gate, permission))
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const items = await listVisibleAttachments(
      gate.user.orgId,
      targetTable,
      targetId,
      fileViewer(gate),
    );
    return NextResponse.json({ attachments: items });
  },
});

/**
 * Attach a file to a record. Two modes:
 *   - multipart upload (file + targetTable + targetId): auto-creates a
 *     per-record folder, stores the file, and links it.
 *   - JSON ({ fileId, targetTable, targetId }): links an existing file.
 */
export const POST = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: gate }) => {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.startsWith("multipart/form-data")) {
      const form = await req.formData().catch(() => null);
      if (!form)
        return NextResponse.json(
          { error: "expected multipart/form-data" },
          { status: 400 },
        );
      const file = form.get("file");
      const targetTable = String(form.get("targetTable") ?? "");
      const targetId = String(form.get("targetId") ?? "");
      if (!(file instanceof File))
        return NextResponse.json(
          { error: "file is required" },
          { status: 400 },
        );
      if (!targetTable || !isUuid(targetId)) {
        return NextResponse.json(
          { error: "targetTable and targetId are required" },
          { status: 400 },
        );
      }
      if (!isAttachableTargetTable(targetTable)) {
        return NextResponse.json(
          { error: "unsupported targetTable" },
          { status: 422 },
        );
      }
      const target = await loadAttachmentTarget(
        gate.user.orgId,
        targetTable,
        targetId,
      );
      if (!target || !attachmentTargetInScope(gate, target))
        return notFound("record");
      if (!canMutateFiles(gate, targetTable, target.kind))
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      if (!isAllowedContentType(file.type)) {
        return NextResponse.json(
          { error: `unsupported file type: ${file.type || "unknown"}` },
          { status: 415 },
        );
      }
      if (file.size > MAX_BYTES)
        return NextResponse.json(
          { error: "file exceeds 25 MB limit" },
          { status: 413 },
        );

      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > MAX_BYTES)
        return NextResponse.json(
          { error: "file exceeds 25 MB limit" },
          { status: 413 },
        );
      if (bytes.length === 0)
        return NextResponse.json({ error: "file is empty" }, { status: 400 });

      let meta: Awaited<ReturnType<typeof uploadAndAttach>>;
      try {
        meta = await uploadAndAttach({
          orgId: gate.user.orgId,
          targetTable,
          targetId,
          filename: file.name || "attachment",
          contentType: file.type.split(";")[0]!.trim().toLowerCase(),
          bytes,
          createdBy: gate.user.id,
          authorizeTarget: (tx) =>
            authorizeAttachmentTargetMutation(gate, targetTable, targetId, tx),
        });
      } catch (error) {
        const refusal = attachmentMutationRefusal(error);
        if (refusal) return refusal;
        throw error;
      }
      return NextResponse.json({ attachment: meta }, { status: 201 });
    }

    // JSON mode: attach an existing file

    const parsed = await parseJsonBody(req, postBodySchema0);
    if (!parsed.ok) return parsed.response;
    const { fileId, targetId, targetTable } = parsed.data;
    const target = await loadAttachmentTarget(
      gate.user.orgId,
      targetTable,
      targetId,
    );
    if (!target || !attachmentTargetInScope(gate, target))
      return notFound("record");
    if (!canMutateFiles(gate, targetTable, target.kind))
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    // The file must belong to the caller's org and be visible to them —
    // blocks cross-org links and attaching out of someone else's private folder.
    if (!(await getFile(gate.user.orgId, fileId, fileViewer(gate)))) {
      return NextResponse.json({ error: "file not found" }, { status: 404 });
    }
    let id: string | null;
    try {
      id = await attachExisting({
        orgId: gate.user.orgId,
        fileId,
        targetTable,
        targetId,
        createdBy: gate.user.id,
        authorizeTarget: (tx) =>
          authorizeAttachmentTargetMutation(gate, targetTable, targetId, tx),
      });
    } catch (error) {
      const refusal = attachmentMutationRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
    if (!id)
      return NextResponse.json({ error: "already attached" }, { status: 409 });
    return NextResponse.json({ id }, { status: 201 });
  },
});
