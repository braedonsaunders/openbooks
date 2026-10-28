import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guardSubsidiaryScope } from "@/lib/authz";
import { customFieldViewerFor } from "@/lib/custom-fields";
import { isUuid } from "@/lib/list-params";
import { loadAccount, redactAccountCustomFields } from "@/lib/accounts/read";
import { notFound } from "@/lib/api/responses";
import { updateAccountAction, updateAccountBodySchema } from "@/lib/accounts/update-action";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "gl.read",
  feature: {
    none: "Chart of accounts records are always available and are governed by account permissions.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const payload = await loadAccount(id, gate.user.orgId, gate.allowedSubsidiaryIds);
    if (!payload) return notFound("record");
    const denied = guardSubsidiaryScope(gate, payload.account.subsidiary_id as string | null, {
      orgWideNull: true,
    });
    if (denied) return denied;
    return NextResponse.json(await redactAccountCustomFields(payload, customFieldViewerFor(gate)));
  },
});

export const PATCH = defineRoute({
  permission: "gl.manage",
  feature: {
    none: "Chart of accounts updates are always available and are governed by account permissions.",
  },
  params: z.object({ id: z.string() }),
  body: updateAccountBodySchema,
  handler: updateAccountAction,
});
