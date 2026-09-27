import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@openbooks/engine/src/platform/db.ts";
import { sealJson, SecretIntegrityError, unsealJson } from "@openbooks/engine/src/platform/secrets.ts";
import {
  getConnection,
  sourceType,
  validateSourceConfig,
  validateSourceSecret,
} from "@openbooks/engine/src/sync/connection.ts";
import { terminateConnectionSessions } from "@openbooks/engine/src/qbd/bridge.ts";
import { nextMirrorAt } from "@openbooks/engine/src/sync/mirror-schedule.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { connectionAuditChanges } from "@openbooks/schema/src/connections.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../../../lib/authz";
import { storageIdentityError } from "../_storage-identity";
import {
  callerOwnedConfigRefusal,
  connectionConfigUrlRefusal,
  mergedDeclaredSourceConfig,
} from "../_connector-guard";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

// Connector config fields are versioned by the source manifest at runtime.
const connectionPatchBody = z.object({
  displayName: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  mirrorEnabled: z.boolean().optional(),
  mirrorSchedule: z.string().optional(),
  postedChangePolicy: z.enum(["review_required", "append_only_automatic"]).optional(),
  status: z.enum(["active", "paused"]).optional(),
}).strict();

/**
 * An unparseable mirror schedule refuses at 400 with the reason intact.
 * nextMirrorAt throws it as a plain Error, which the sanitizer would
 * otherwise genericize to a 500.
 */
class MirrorScheduleRefusal extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "MirrorScheduleRefusal";
  }
}

/**
 * A stored credential that no longer unseals refuses at 400 with the
 * integrity error's own remedy intact. Thrown as a named class (never a
 * plain Error) so the sanitizer surfaces it instead of genericizing to
 * a 500.
 */
class ConnectionSecretsRefusal extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ConnectionSecretsRefusal";
  }
}

/**
 * Update a connection: rename, edit config, rotate/add secrets, toggle mirror,
 * pause/resume. Secrets are merged (only provided fields change) then re-sealed;
 * they are never returned.
 */
async function patchConnection(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  const orgId = gate.user.orgId;
  const { id } = await params;

  const parsedBody = await parseJsonBody(req, connectionPatchBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if (body.config && typeof body.config === "object") {
    const ownedError = callerOwnedConfigRefusal(body.config);
    if (ownedError) {
      return NextResponse.json(
        { error: ownedError, errorCode: "OAUTH_IDENTITY_REFUSED" },
        { status: 400 },
      );
    }
  }
  const today =
    body.config && typeof body.config === "object"
      ? await businessToday(orgId)
      : undefined;

  // A malformed id surfaces as a Postgres input error from the first
  // lookup; resolve it through the not-found contract, never a raw 500.
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.orgId, orgId),
          eq(schema.connections.id, id),
        ),
      )
      .for("update");
    if (!existing) {
      return notFound("record");
    }

    const manifest = sourceType(existing.source);
    const updates: Partial<typeof schema.connections.$inferInsert> = {};
    let credentialsChanged = false;

    if (typeof body.displayName === "string" && body.displayName.trim()) {
      updates.displayName = body.displayName.trim();
    }
    if (body.config && typeof body.config === "object") {
      const currentConfig =
        existing.config &&
        typeof existing.config === "object" &&
        !Array.isArray(existing.config)
          ? existing.config
          : {};
      if (!manifest) {
        return NextResponse.json(
          { error: "unknown source type" },
          { status: 400 },
        );
      }
      const merged = mergedDeclaredSourceConfig(
        manifest,
        currentConfig as Record<string, unknown>,
        body.config as Record<string, unknown>,
      );
      const urlError = await connectionConfigUrlRefusal(merged);
      if (urlError) {
        return NextResponse.json(
          { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" },
          { status: 400 },
        );
      }
      const configError = validateSourceConfig(manifest, merged, { today });
      if (configError) {
        return NextResponse.json({ error: configError }, { status: 400 });
      }
      updates.config = merged;
    }
    if (body.secrets && manifest) {
      // A tampered stored credential refuses as unreadable — re-enter it —
      // the same shape as a missing one, never a 500. The merge below cannot
      // proceed without the current secrets, so the refusal carries the
      // integrity error's own remedy.
      let current: Record<string, string>;
      try {
        current =
          existing.secrets == null
            ? {}
            : unsealJson<Record<string, string>>(existing.secrets, { orgId, purpose: "connection.secrets" });
      } catch (error) {
        if (!(error instanceof SecretIntegrityError)) throw error;
        console.error("[connections] stored credential failed integrity check:", {
          orgId,
          connectionId: id,
          purpose: error.purpose,
          keyId: error.keyId,
        });
        return apiErrorResponse(new ConnectionSecretsRefusal(error.message));
      }
      for (const field of manifest.secretFields) {
        const value = body.secrets[field.key];
        if (value !== undefined && value !== null && String(value) !== "") {
          const secretError = validateSourceSecret(
            existing.source,
            field.key,
            String(value),
          );
          if (secretError) {
            return NextResponse.json(
              { error: secretError },
              { status: 400 },
            );
          }
          current[field.key] = String(value);
          credentialsChanged = true;
        }
      }
      if (credentialsChanged) {
        updates.secrets = sealJson(current, { orgId, purpose: "connection.secrets" });
        // Providing credentials clears the "unconfigured" state.
        if (existing.status === "unconfigured") updates.status = "active";
      }
    }
    if (typeof body.mirrorEnabled === "boolean") {
      updates.mirrorEnabled = body.mirrorEnabled;
    }
    if (typeof body.mirrorSchedule === "string") {
      try {
        nextMirrorAt(body.mirrorSchedule, new Date());
      } catch (error) {
        return apiErrorResponse(error instanceof Error ? new MirrorScheduleRefusal(error.message) : error);
      }
      updates.mirrorSchedule = body.mirrorSchedule;
    }
    if (
      body.postedChangePolicy !== undefined &&
      body.postedChangePolicy !== existing.postedChangePolicy
    ) {
      if (
        body.postedChangePolicy !== "review_required" &&
        body.postedChangePolicy !== "append_only_automatic"
      ) {
        return NextResponse.json(
          { error: "invalid posted-change policy" },
          { status: 400 },
        );
      }
      updates.postedChangePolicy = body.postedChangePolicy;
      updates.postedChangeAuthorizedBy =
        body.postedChangePolicy === "append_only_automatic"
          ? gate.user.id
          : null;
      updates.postedChangeAuthorizedAt =
        body.postedChangePolicy === "append_only_automatic"
          ? new Date()
          : null;
    }
    if (body.status === "active" || body.status === "paused") {
      updates.status = body.status;
    }

    if (Object.keys(updates).length === 0) return null;
    updates.updatedAt = new Date();
    updates.updatedBy = gate.user.id;
    const [updated] = await tx
      .update(schema.connections)
      .set(updates)
      .where(
        and(
          eq(schema.connections.orgId, orgId),
          eq(schema.connections.id, id),
        ),
      )
      .returning();
    if (!updated) throw new Error("connection update returned no row");
    await tx.insert(schema.auditLog).values({
      orgId,
      tableName: "connections",
      rowId: id,
      action: "update",
      changes: connectionAuditChanges({
        event: "connection_updated",
        before: existing,
        after: updated,
        credentialsChanged,
      }),
      actorId: gate.user.id,
    });
    return updated;
  }).catch((e) => {
    if (storageIdentityError(e)) return notFound("record");
    throw e;
  });
  if (result instanceof NextResponse) return result;
  // Pausing must stop an already-authenticated ticket: terminate the
  // connection's open Web Connector sessions and re-queue their in-flight
  // requests (same shape as close), so a ticket issued before the pause
  // claims and submits nothing afterwards. Termination is idempotent — a
  // repeat pause with no open sessions touches nothing.
  if (body.status === "paused" && result && result.source === "qbd") {
    await terminateConnectionSessions(orgId, id);
  }
  return NextResponse.json({ ok: true });
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
