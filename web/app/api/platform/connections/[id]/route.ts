import { parseJsonBody } from "@/lib/api/json";
import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { getConnection } from "@openbooks/engine/src/sync/connection.ts";
import { connectionAuditChanges } from "@openbooks/schema/src/connections.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../../../lib/authz";
import { storageIdentityError } from "../_storage-identity";
import { notFound } from "@/lib/api/responses";
import { connectionPatchBody, updateConnection } from "../../../../../lib/sync/connection-update";


export const runtime = "nodejs";

/**
 * Update a connection through the shared audited command (rename, config,
 * secrets, mirror, posted-change policy, pause/resume).
 */
async function patchConnection(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  const { id } = await params;

  const parsedBody = await parseJsonBody(req, connectionPatchBody);
  if (!parsedBody.ok) return parsedBody.response;
  const outcome = await updateConnection({ orgId: gate.user.orgId, userId: gate.user.id }, id, parsedBody.data);
  return NextResponse.json(outcome.body, { status: outcome.status });
}

async function deleteConnection(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  const orgId = gate.user.orgId;
  const { id } = await params;
  const existing = await getConnection(orgId, id).catch((e) => {
    if (storageIdentityError(e)) return null;
    throw e;
  });
  if (!existing)
    return notFound("record");
  const deleted = await db.transaction(async (tx) => {
    // Preserve run history while detaching it from the connection being
    // removed.  The migration makes connection_id nullable; doing this
    // explicitly keeps the delete independent of deferred FK timing.
    await tx.execute(sql`
      update sync_runs
         set connection_id = null
       where org_id = ${orgId} and connection_id = ${id}
    `);
    const removed = await tx.execute<{ id: string }>(sql`
      delete from connections
       where org_id = ${orgId} and id = ${id}
       returning id
    `);
    if (!removed.rows[0]) return null;
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${orgId}, 'connections', ${id}, 'delete',
        ${JSON.stringify(
          connectionAuditChanges({
            event: "connection_deleted",
            before: existing,
            after: null,
            credentialsChanged: existing.secrets != null,
          }),
        )}::jsonb,
        ${gate.user.id}
      )
    `);
    return removed.rows[0];
  }).catch((e) => {
    if (storageIdentityError(e)) return null;
    throw e;
  });
  if (!deleted) {
    return notFound("record");
  }
  return NextResponse.json({ ok: true });
}

const connectionParams = z.object({ id: z.string() })
export const PATCH = defineRoute({
  authorize: () => guardPermission('admin.setup.manage'),
  feature: { none: 'Connection configuration is governed by the org-wide setup permission and subsidiary-scope guard.' },
  params: connectionParams,
  handler: async ({ request, params }) => patchConnection(request, { params: Promise.resolve(params) }),
})
export const DELETE = defineRoute({
  authorize: () => guardPermission('admin.setup.manage'),
  feature: { none: 'Connection deletion is governed by the org-wide setup permission and subsidiary-scope guard.' },
  params: connectionParams,
  handler: async ({ request, params }) => deleteConnection(request, { params: Promise.resolve(params) }),
})
