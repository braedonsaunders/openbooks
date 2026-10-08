import "server-only";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { auditLog, connections } from "@openbooks/schema";
import {
  nextMirrorAt,
  sealJson,
  SecretIntegrityError,
  sourceType,
  terminateConnectionSessions,
  unsealJson,
  validateSourceConfig,
  validateSourceSecret,
} from "@openbooks/engine/sync";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { connectionAuditChanges } from "@openbooks/schema/src/connections.ts";
import { storageIdentityError } from "../../app/api/platform/connections/_storage-identity";
import {
  callerOwnedConfigRefusal,
  connectionConfigUrlRefusal,
  mergedDeclaredSourceConfig,
} from "../../app/api/platform/connections/_connector-guard";

// Connector config fields are versioned by the source manifest at runtime.
export const connectionPatchBody = z.object({
  displayName: z.string().optional(),
  config: z.record(z.string(), z.json()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  mirrorEnabled: z.boolean().optional(),
  mirrorSchedule: z.string().optional(),
  postedChangePolicy: z.enum(["review_required", "append_only_automatic"]).optional(),
  status: z.enum(["active", "paused"]).optional(),
}).strict();
export type ConnectionPatch = z.infer<typeof connectionPatchBody>;

export type ConnectionUpdateOutcome = { status: number; body: Record<string, unknown> };

const refused = (status: number, body: Record<string, unknown>): ConnectionUpdateOutcome => ({ status, body });

/**
 * Update a connection: rename, edit config, rotate/add secrets, toggle mirror,
 * pause/resume. Secrets are merged (only provided fields change) then
 * re-sealed; they are never returned. One audited write path shared by the
 * Migration & Sync page and the migration assistant. The caller has already
 * established `admin.setup.manage` with unrestricted subsidiary scope.
 */
export async function updateConnection(
  actor: { orgId: string; userId: string },
  id: string,
  body: ConnectionPatch,
): Promise<ConnectionUpdateOutcome> {
  const { orgId } = actor;
  if (body.config && typeof body.config === "object") {
    const ownedError = callerOwnedConfigRefusal(body.config);
    if (ownedError) return refused(400, { error: ownedError, errorCode: "OAUTH_IDENTITY_REFUSED" });
  }
  const today =
    body.config && typeof body.config === "object"
      ? await businessToday(orgId)
      : undefined;

  // A malformed id surfaces as a Postgres input error from the first
  // lookup; resolve it through the not-found contract, never a raw 500.
  type Settled = { refusal: ConnectionUpdateOutcome } | { updated: typeof connections.$inferSelect | null };
  const result = await db.transaction(async (tx): Promise<Settled> => {
    const [existing] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.id, id),
        ),
      )
      .for("update");
    if (!existing) return { refusal: refused(404, { error: "not_found" }) };

    const manifest = sourceType(existing.source);
    const updates: Partial<typeof connections.$inferInsert> = {};
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
      if (!manifest) return { refusal: refused(400, { error: "unknown source type" }) };
      const merged = mergedDeclaredSourceConfig(
        manifest,
        currentConfig as Record<string, unknown>,
        body.config as Record<string, unknown>,
      );
      const urlError = await connectionConfigUrlRefusal(merged);
      if (urlError) return { refusal: refused(400, { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" }) };
      const configError = validateSourceConfig(manifest, merged, { today });
      if (configError) return { refusal: refused(400, { error: configError }) };
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
        return { refusal: refused(400, { error: error.message }) };
      }
      for (const field of manifest.secretFields) {
        const value = body.secrets[field.key];
        if (value !== undefined && value !== null && String(value) !== "") {
          const secretError = validateSourceSecret(
            existing.source,
            field.key,
            String(value),
          );
          if (secretError) return { refusal: refused(400, { error: secretError }) };
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
        // An unparseable mirror schedule refuses with the reason intact.
        return { refusal: refused(400, { error: error instanceof Error ? error.message : "invalid mirror schedule" }) };
      }
      updates.mirrorSchedule = body.mirrorSchedule;
    }
    if (
      body.postedChangePolicy !== undefined &&
      body.postedChangePolicy !== existing.postedChangePolicy
    ) {
      updates.postedChangePolicy = body.postedChangePolicy;
      updates.postedChangeAuthorizedBy =
        body.postedChangePolicy === "append_only_automatic"
          ? actor.userId
          : null;
      updates.postedChangeAuthorizedAt =
        body.postedChangePolicy === "append_only_automatic"
          ? new Date()
          : null;
    }
    if (body.status === "active" || body.status === "paused") {
      updates.status = body.status;
    }

    if (Object.keys(updates).length === 0) return { updated: null };
    updates.updatedAt = new Date();
    updates.updatedBy = actor.userId;
    const [updated] = await tx
      .update(connections)
      .set(updates)
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.id, id),
        ),
      )
      .returning();
    if (!updated) throw new Error("connection update returned no row");
    await tx.insert(auditLog).values({
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
      actorId: actor.userId,
    });
    return { updated };
  }).catch((e) => {
    if (storageIdentityError(e)) return { refusal: refused(404, { error: "not_found" }) };
    throw e;
  });
  if ("refusal" in result) return result.refusal;
  const { updated } = result;
  // Pausing must stop an already-authenticated ticket: terminate the
  // connection's open Web Connector sessions and re-queue their in-flight
  // requests (same shape as close), so a ticket issued before the pause
  // claims and submits nothing afterwards. Termination is idempotent — a
  // repeat pause with no open sessions touches nothing.
  if (body.status === "paused" && updated && updated.source === "qbd") {
    await terminateConnectionSessions(orgId, id);
  }
  return { status: 200, body: { ok: true } };
}
