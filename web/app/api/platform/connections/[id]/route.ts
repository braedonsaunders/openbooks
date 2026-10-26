import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { deleteConnectionRecord } from "@openbooks/engine/sync/connection-admin";
import { storageIdentityError } from "../_storage-identity";
import { notFound } from "@/lib/api/responses";
import { connectionPatchBody, updateConnection } from "@/lib/sync/connection-update";

export const runtime = "nodejs";

/**
 * Update a connection through the shared audited command (rename, config,
 * secrets, mirror, posted-change policy, pause/resume).
 */
async function patchConnection(
  gate: { user: { orgId: string; id: string } },
  id: string,
  body: Parameters<typeof updateConnection>[2],
) {
  const outcome = await updateConnection(
    { orgId: gate.user.orgId, userId: gate.user.id },
    id,
    body,
  );
  return NextResponse.json(outcome.body, { status: outcome.status });
}

async function deleteConnection(gate: { user: { orgId: string; id: string } }, id: string) {
  const orgId = gate.user.orgId;
  const deleted = await deleteConnectionRecord(orgId, id, gate.user.id).catch((e) => {
    if (storageIdentityError(e)) return null;
    throw e;
  });
  if (!deleted) {
    return notFound("record");
  }
  return NextResponse.json({ ok: true });
}

const connectionParams = z.object({ id: z.string() });
export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Connection configuration is governed by the org-wide setup permission and subsidiary-scope guard.",
  },
  scope: "unrestricted",
  params: connectionParams,
  body: connectionPatchBody,
  handler: async ({ authz, params, body }) => patchConnection(authz, params.id, body),
});
export const DELETE = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Connection deletion is governed by the org-wide setup permission and subsidiary-scope guard.",
  },
  scope: "unrestricted",
  params: connectionParams,
  handler: async ({ authz, params }) => deleteConnection(authz, params.id),
});
