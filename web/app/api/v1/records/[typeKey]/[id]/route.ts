import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { canApi, logKeyEvent, resolveApiKeyAuth, type ApiKeyAuth } from "../../../../../../lib/api-auth";
import { loadApiSchema, resolveApiType } from "../../../../../../lib/api/schema-registry";
import { deleteRecord, updateRecord } from "../../../../../../lib/api/writers";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/** GET /api/v1/records/[typeKey]/[id] — get one record by id. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const start = Date.now();
  const { typeKey, id } = await params;

  const auth = await resolveApiKeyAuth(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const resolved = await resolveApiType(auth.user.orgId, typeKey);
  if (!resolved) return NextResponse.json({ error: "unknown record type" }, { status: 404 });
  if (!canApi(auth, resolved.readPermission)) {
    return NextResponse.json({ error: `missing permission: ${resolved.readPermission}` }, { status: 403 });
  }

  const tableName = sql.raw(resolved.table);
  const docKind = resolved.writer.kind === "document" ? resolved.writer.docKind : null;
  const row = (await db.execute(sql`
    select * from ${tableName}
     where id = ${id} and org_id = ${auth.user.orgId}
     ${docKind ? sql`and kind = ${docKind}` : sql``}
     ${resolved.dynamic ? sql`and type_key = ${resolved.key}` : sql``}
     limit 1`)) as any;

  if (!row.rows[0]) {
    done(req, start, 404, auth);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  done(req, start, 200, auth);
  return NextResponse.json(row.rows[0]);
}

/** PATCH /api/v1/records/[typeKey]/[id] — update a record. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const start = Date.now();
  const { typeKey, id } = await params;

  const auth = await resolveApiKeyAuth(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const gate = await guardWrite(auth, typeKey, "update", req, start);
  if (gate instanceof NextResponse) return gate;
  const { resolved } = gate;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    done(req, start, 400, auth);
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const fields = resolved.writer.kind === "entity"
    ? (await loadApiSchema(auth.user.orgId)).find((s) => s.key === resolved.key)?.fields ?? []
    : [];

  const result = await updateRecord(auth.user, resolved, fields, id, body);
  done(req, start, result.status, auth);
  return NextResponse.json(result.body, { status: result.status });
}

/** DELETE /api/v1/records/[typeKey]/[id] — delete a record. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const start = Date.now();
  const { typeKey, id } = await params;

  const auth = await resolveApiKeyAuth(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const gate = await guardWrite(auth, typeKey, "delete", req, start);
  if (gate instanceof NextResponse) return gate;

  const result = await deleteRecord(auth.user, gate.resolved, id);
  done(req, start, result.status, auth);
  return NextResponse.json(result.body, { status: result.status });
}

/** Resolve + authorize a write; returns the resolved type or a ready response. */
async function guardWrite(
  auth: ApiKeyAuth,
  typeKey: string,
  op: "update" | "delete",
  req: Request,
  start: number,
) {
  const resolved = await resolveApiType(auth.user.orgId, typeKey);
  if (!resolved) {
    done(req, start, 404, auth);
    return NextResponse.json({ error: "unknown record type" }, { status: 404 });
  }
  if (!resolved.operations.includes(op) || !resolved.writePermission) {
    done(req, start, 405, auth);
    return NextResponse.json({ error: `${typeKey} does not support ${op}` }, { status: 405 });
  }
  if (!canApi(auth, resolved.writePermission)) {
    done(req, start, 403, auth);
    return NextResponse.json({ error: `missing permission: ${resolved.writePermission}` }, { status: 403 });
  }
  return { resolved };
}

function done(req: Request, start: number, status: number, auth: ApiKeyAuth) {
  logKeyEvent({
    orgId: auth.user.orgId, keyId: auth.keyId, method: req.method,
    path: new URL(req.url).pathname, statusCode: status, durationMs: Date.now() - start, req,
  });
}
