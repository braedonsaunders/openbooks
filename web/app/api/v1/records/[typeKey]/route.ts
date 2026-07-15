import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { canApi, logKeyEvent, resolveApiKeyAuth, type ApiKeyAuth } from "../../../../../lib/api-auth";
import { API_RECORD_TYPES } from "../../../../../lib/api/schema-registry";
import { clamp } from "../../../../../lib/list-params";

export const runtime = "nodejs";

/** Map record-type keys that share the `documents` table to their kind. */
const DOC_KIND: Record<string, string> = {
  bills: "vendor_bill",
  invoices: "customer_invoice",
  payments: "vendor_payment",
};

/**
 * Search column per table. `custom_records` has a precomputed haystack;
 * `documents` and `journal_entries` have no `name` column, and `parties`
 * calls it `display_name`. Everything else searches `name`.
 */
const SEARCH_COLUMNS: Record<string, string> = {
  custom_records: "search_text",
  documents: "document_number",
  journal_entries: "entry_number",
  parties: "display_name",
};

interface ResolvedType {
  key: string;
  table: string;
  readPermission: string;
  writePermission: string | null;
  dynamic: boolean;
  docKind?: string;
}

function resolveBuiltIn(typeKey: string): ResolvedType | null {
  const docKind = DOC_KIND[typeKey];
  if (docKind) {
    const rt = API_RECORD_TYPES.find((t) => t.key === typeKey);
    if (!rt) return null;
    return {
      key: rt.key, table: rt.table!, readPermission: rt.readPermission,
      writePermission: rt.writePermission, dynamic: false, docKind,
    };
  }
  const rt = API_RECORD_TYPES.find((t) => t.key === typeKey);
  if (rt && rt.table !== "documents") {
    return {
      key: rt.key, table: rt.table!, readPermission: rt.readPermission,
      writePermission: rt.writePermission, dynamic: false,
    };
  }
  return null;
}

async function loadCustomType(orgId: string, typeKey: string): Promise<ResolvedType | null> {
  const r = (await db.execute(sql`
    select key from custom_record_types
     where org_id = ${orgId} and key = ${typeKey} and status = 'published'`)) as any;
  if (!r.rows[0]) return null;
  return {
    key: typeKey, table: "custom_records", readPermission: "records.read",
    writePermission: "records.create", dynamic: true,
  };
}

/** GET /api/v1/records/[typeKey] — list with search + pagination. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ typeKey: string }> },
) {
  const start = Date.now();
  const { typeKey } = await params;

  // Authenticate only — the required permission is per record type, checked
  // below once the type is resolved (a key scoped to e.g. ar.read must be
  // able to list invoices without holding gl.read).
  const auth = await resolveApiKeyAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  }

  const resolved = resolveBuiltIn(typeKey) ?? (await loadCustomType(auth.user.orgId, typeKey));
  if (!resolved) {
    const res = NextResponse.json({ error: "unknown record type" }, { status: 404 });
    done(req, start, 404, auth);
    return res;
  }

  if (!canApi(auth, resolved.readPermission)) {
    const res = NextResponse.json(
      { error: `missing permission: ${resolved.readPermission}` },
      { status: 403 },
    );
    done(req, start, 403, auth);
    return res;
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const page = clamp(Number(url.searchParams.get("page") ?? "1"), 1, 10_000);
  const perPage = clamp(Number(url.searchParams.get("perPage") ?? "25"), 5, 100);
  const tableName = sql.raw(resolved.table);
  const searchCol = sql.raw(SEARCH_COLUMNS[resolved.table] ?? "name");

  const conditions: SQL[] = [sql`org_id = ${auth.user.orgId}`];
  if (resolved.docKind) conditions.push(sql`kind = ${resolved.docKind}`);
  if (resolved.dynamic) conditions.push(sql`type_key = ${resolved.key}`);
  if (q) {
    // Escape LIKE metacharacters so a literal % or _ in the query can't
    // change the match semantics.
    const escaped = q.replace(/[\\%_]/g, (m) => "\\" + m);
    conditions.push(sql`${searchCol} ilike ${"%" + escaped.toLowerCase() + "%"}`);
  }
  const where = sql.join(conditions, sql` and `);

  const [rows, count] = await Promise.all([
    db.execute(sql`
      select * from ${tableName}
       where ${where}
       order by created_at desc
       limit ${perPage} offset ${(page - 1) * perPage}`) as any,
    db.execute(sql`select count(*) as n from ${tableName} where ${where}`) as any,
  ]);

  done(req, start, 200, auth);
  return NextResponse.json({
    records: rows.rows,
    total: Number(count.rows[0].n),
    page,
    perPage,
  });
}

function done(req: Request, start: number, status: number, auth: ApiKeyAuth) {
  logKeyEvent({
    orgId: auth.user.orgId, keyId: auth.keyId, method: req.method,
    path: new URL(req.url).pathname, statusCode: status, durationMs: Date.now() - start, req,
  });
}
