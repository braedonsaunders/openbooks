import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveSourceDeletion,
  SourceDeletionResolutionError,
} from "@openbooks/engine/src/sync/source-deletions.ts";
import { storageIdentityError } from "../../../_storage-identity";
import { notFound } from "@/lib/api/responses";


const deletionBody = z.object({ action: z.enum(["retain", "void"]), note: z.string().optional() });

export const POST = defineRoute({
  permission: "admin.setup.manage", feature: { none: "Source-deletion decisions are controlled by connection setup permission and have no separate organization feature gate." },
  scope: "unrestricted", params: z.object({ id: z.string().uuid(), ref: z.string().min(1) }), body: deletionBody,
  handler: async ({ params: { id, ref }, body, authz: gate }) => {
  try {
    const result = await resolveSourceDeletion({
      orgId: gate.user.orgId,
      connectionId: id,
      sourceRef: ref,
      action: body.action,
      actorId: gate.user.id,
      note: body.note?.trim() || null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SourceDeletionResolutionError) {
      return apiErrorResponse(error, { safeStatus: 422 });
    }
    if (storageIdentityError(error)) {
      return notFound("record");
    }
    throw error;
  }
  },
});
