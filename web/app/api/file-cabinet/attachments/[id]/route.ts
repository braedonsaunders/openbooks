import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  detachAttachment,
  getAttachmentLink,
} from "../../../../../lib/file-cabinet";
import { can } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import {
  attachmentReadPermission,
  attachmentMutationRefusal,
  attachmentTargetInScope,
  authorizeAttachmentTargetMutation,
  canMutateFiles,
  loadAttachmentTarget,
} from "../../lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Detach a file from a record (does NOT delete the file).
 *
 * Detaching mutates a record's evidence, so it applies the same target gate
 * the attachment listing applies — the owning record must be inside the
 * caller's subsidiary scope (hidden ⇒ indistinguishable 404) and the caller
 * must hold the record family's permission — on top of the cabinet mutation
 * gate. The service refuses to detach from posted documents, active
 * compliance records and fixed assets (their evidence is retained exactly as
 * purge refuses to destroy it); that refusal surfaces as 409.
 */
export const DELETE = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    const link = await getAttachmentLink(gate.user.orgId, id);
    if (!link)
      return notFound("record");
    const target = await loadAttachmentTarget(
      gate.user.orgId,
      link.targetTable,
      link.targetId,
    );
    if (!target || !attachmentTargetInScope(gate, target)) {
      return notFound("record");
    }
    const permission = attachmentReadPermission(link.targetTable, target.kind);
    if (!permission)
      return notFound("record");
    if (
      !can(gate, permission) ||
      !canMutateFiles(gate, link.targetTable, target.kind)
    ) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    let result: Awaited<ReturnType<typeof detachAttachment>>;
    try {
      result = await detachAttachment(gate.user.orgId, id, {
        actorId: gate.user.id,
        authorizeAttachmentTarget: (tx, target) =>
          authorizeAttachmentTargetMutation(
            gate,
            target.targetTable,
            target.targetId,
            tx,
          ),
      });
    } catch (error) {
      const refusal = attachmentMutationRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
    if (!result.ok) {
      if (result.reason === "retained") {
        return NextResponse.json(
          { error: "attachments of posted or active records are retained" },
          { status: 409 },
        );
      }
      return notFound("record");
    }
    return NextResponse.json({ ok: true });
  },
});
