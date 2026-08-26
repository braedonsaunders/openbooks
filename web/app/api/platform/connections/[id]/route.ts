import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@openbooks/engine/src/db.ts";
import { sealJson, unsealJson } from "@openbooks/engine/src/secrets.ts";
import {
  getConnection,
  sourceType,
  validateSourceConfig,
  validateSourceSecret,
} from "@openbooks/engine/src/sync/connection.ts";
import { nextMirrorAt } from "@openbooks/engine/src/sync/mirror-schedule.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { connectionAuditChanges } from "@openbooks/schema/src/connections.ts";
import { guardPermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

/**
 * Update a connection: rename, edit config, rotate/add secrets, toggle mirror,
 * pause/resume. Secrets are merged (only provided fields change) then re-sealed;
 * they are never returned.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const { id } = await params;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    displayName?: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
    mirrorEnabled?: boolean;
    mirrorSchedule?: string;
    postedChangePolicy?: "review_required" | "append_only_automatic";
    status?: "active" | "paused";
  };
  const today =
    body.config && typeof body.config === "object"
      ? await businessToday(orgId)
      : undefined;

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
      return NextResponse.json({ error: "not found" }, { status: 404 });
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
      const merged = { ...currentConfig, ...body.config };
      if (manifest) {
        const configError = validateSourceConfig(manifest, merged, { today });
        if (configError) {
          return NextResponse.json({ error: configError }, { status: 400 });
        }
      }
      updates.config = merged;
    }
    if (body.secrets && manifest) {
      const current =
        unsealJson<Record<string, string>>(existing.secrets) ?? {};
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
        updates.secrets = sealJson(current);
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
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 400 },
        );
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
  });
  if (result instanceof NextResponse) return result;
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const { id } = await params;
  const existing = await getConnection(orgId, id);
  if (!existing)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`delete from connections where org_id = ${orgId} and id = ${id}`,
    );
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
  });
  return NextResponse.json({ ok: true });
}
