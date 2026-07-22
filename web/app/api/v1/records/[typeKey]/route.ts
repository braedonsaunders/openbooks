import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { canApi, enforceRateLimit, logKeyEvent, resolveApiKeyAuth, type ApiKeyAuth } from "../../../../../lib/api-auth";
import { loadApiSchema, resolveApiType, type ResolvedApiType } from "../../../../../lib/api/schema-registry";
import { createRecord } from "../../../../../lib/api/writers";
import { clamp } from "../../../../../lib/list-params";

export const runtime = "nodejs";

/** GET /api/v1/records/[typeKey] — list with search + pagination. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ typeKey: string }> },
) {
  const start = Date.now();
  const { typeKey } = await params;

  // Authenticate only — the required permission is per record type, checked
  // below once the type is resolved (a key scoped to e.g. ar.read must be able
  // to list invoices without holding gl.read).
  const auth = await resolveApiKeyAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  }
  const limited = await enforceRateLimit(auth, req, start);
  if (limited) return limited;

  const resolved = await resolveApiType(auth.user.orgId, typeKey);
  if (!resolved) {
    done(req, start, 404, auth);
    return NextResponse.json({ error: "unknown record type" }, { status: 404 });
  }

  if (!canApi(auth, resolved.readPermission)) {
    done(req, start, 403, auth);
    return NextResponse.json({ error: `missing permission: ${resolved.readPermission}` }, { status: 403 });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const page = clamp(Number(url.searchParams.get("page") ?? "1"), 1, 10_000);
  const perPage = clamp(Number(url.searchParams.get("perPage") ?? "25"), 5, 100);

  const where = listWhere(resolved, auth.user.orgId, q);
  const tableName = sql.raw(resolved.table);

  const [rows, count] = await Promise.all([
    db.execute(sql`
      select * from ${tableName}
       where ${where}
       order by created_at desc
       limit ${perPage} offset ${(page - 1) * perPage}`) as any,
    db.execute(sql`select count(*) as n from ${tableName} where ${where}`) as any,
  ]);

  done(req, start, 200, auth);
  return NextResponse.json({ records: rows.rows, total: Number(count.rows[0].n), page, perPage });
}

/** POST /api/v1/records/[typeKey] — create a record. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ typeKey: string }> },
) {
  const start = Date.now();
  const { typeKey } = await params;

  const auth = await resolveApiKeyAuth(req);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const limited = await enforceRateLimit(auth, req, start);
  if (limited) return limited;

  const resolved = await resolveApiType(auth.user.orgId, typeKey);
  if (!resolved) {
    done(req, start, 404, auth);
    return NextResponse.json({ error: "unknown record type" }, { status: 404 });
  }
  if (!resolved.operations.includes("create") || !resolved.writePermission) {
    done(req, start, 405, auth);
    return NextResponse.json({ error: `${typeKey} does not support create` }, { status: 405 });
  }
  if (!canApi(auth, resolved.writePermission)) {
    done(req, start, 403, auth);
    return NextResponse.json({ error: `missing permission: ${resolved.writePermission}` }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    done(req, start, 400, auth);
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Entity writers validate against the live field schema; other writers own
  // their own definitions.
  const fields = resolved.writer.kind === "entity"
    ? (await loadApiSchema(auth.user.orgId)).find((s) => s.key === resolved.key)?.fields ?? []
    : [];

  const result = await createRecord(auth.user, resolved, fields, body);
  done(req, start, result.status, auth);
  return NextResponse.json(result.body, { status: result.status });
}

/** Build the org-scoped WHERE for a list query (tenant + kind/type + search). */
function listWhere(resolved: ResolvedApiType, orgId: string, q?: string): SQL {
  const conditions: SQL[] = [sql`org_id = ${orgId}`];
  if (resolved.writer.kind === "document") conditions.push(sql`kind = ${resolved.writer.docKind}`);
  if (resolved.dynamic) conditions.push(sql`type_key = ${resolved.key}`);
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (m) => "\\" + m);
    conditions.push(sql`${sql.raw(resolved.searchColumn)} ilike ${"%" + escaped.toLowerCase() + "%"}`);
  }
  return sql.join(conditions, sql` and `);
}

function done(req: Request, start: number, status: number, auth: ApiKeyAuth) {
  logKeyEvent({
    orgId: auth.user.orgId, keyId: auth.keyId, method: req.method,
    path: new URL(req.url).pathname, statusCode: status, durationMs: Date.now() - start, req,
  });
}
