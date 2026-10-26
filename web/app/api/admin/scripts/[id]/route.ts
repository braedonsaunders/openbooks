import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { deleteUserScript } from "@openbooks/engine/scripting/admin";
import type { Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** DELETE — remove only scripts without execution evidence. Scripts with run
 * history must be deactivated instead so their audit trail remains intact. */
async function legacyDELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const user = gate.user;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");

  const result = await deleteUserScript({
    orgId: user.orgId,
    actorId: user.id,
    requestId: req.headers.get("X-Request-Id"),
    id,
  });
  if (result.kind === "feature_disabled" || result.kind === "missing") return notFound("record");
  if (result.kind === "history")
    return NextResponse.json(
      {
        error:
          "This script has run history and cannot be deleted. Deactivate it instead to preserve its audit history.",
        code: "SCRIPT_HAS_RUN_HISTORY",
      },
      { status: 409 },
    );
  return NextResponse.json({ ok: true });
}

export const DELETE = defineRoute({
  permission: "scripts.manage",
  feature: "scripts",
  params: z.object({ id: z.string() }),
  handler: async ({ request, params, authz }) =>
    legacyDELETE(request, { params: Promise.resolve(params) }, authz),
});
