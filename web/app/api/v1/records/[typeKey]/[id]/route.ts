import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { canApi, logKeyEvent, resolveApiKeyAuth } from "../../../../../../lib/api-auth";
import { API_RECORD_TYPES } from "../../../../../../lib/api/schema-registry";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

const DOC_KIND: Record<string, string> = {
  bills: "vendor_bill",
  invoices: "customer_invoice",
  payments: "vendor_payment",
};

function resolveBuiltIn(typeKey: string) {
  const docKind = DOC_KIND[typeKey];
  if (docKind) {
    const rt = API_RECORD_TYPES.find((t) => t.key === typeKey);
    if (!rt) return null;
    return { key: rt.key, table: rt.table!, readPermission: rt.readPermission, docKind };
  }
  const rt = API_RECORD_TYPES.find((t) => t.key === typeKey);
  if (rt && rt.table !== "documents") {
    return { key: rt.key, table: rt.table!, readPermission: rt.readPermission, docKind: undefined as string | undefined };
  }
  return null;
}

async function loadCustomType(orgId: string, typeKey: string) {
  const r = (await db.execute(sql`
    select key from custom_record_types
     where org_id = ${orgId} and key = ${typeKey} and status = 'published'`)) as any;
  if (!r.rows[0]) return null;
  return { key: typeKey, table: "custom_records", readPermission: "records.read", docKind: undefined as string | undefined };
}

/** GET /api/v1/records/[typeKey]/[id] — get one record by id. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const start = Date.now();
  const { typeKey, id } = await params;

  // Authenticate only — the required permission is per record type, checked
  // below once the type is resolved (a key scoped to e.g. ar.read must be
  // able to read invoices without holding gl.read).
  const auth = await resolveApiKeyAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  }

  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const resolved = resolveBuiltIn(typeKey) ?? (await loadCustomType(auth.user.orgId, typeKey));
  if (!resolved) {
    return NextResponse.json({ error: "unknown record type" }, { status: 404 });
  }

  if (!canApi(auth, resolved.readPermission)) {
    return NextResponse.json(
      { error: `missing permission: ${resolved.readPermission}` },
      { status: 403 },
    );
  }

  const tableName = sql.raw(resolved.table);
  const row = (await db.execute(sql`
    select * from ${tableName}
     where id = ${id} and org_id = ${auth.user.orgId}
     ${resolved.docKind ? sql`and kind = ${resolved.docKind}` : sql``}
     ${resolved.table === "custom_records" ? sql`and type_key = ${resolved.key}` : sql``}
     limit 1`)) as any;

  if (!row.rows[0]) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  logKeyEvent({
    orgId: auth.user.orgId, keyId: auth.keyId, method: req.method,
    path: new URL(req.url).pathname, statusCode: 200, durationMs: Date.now() - start, req,
  });
  return NextResponse.json(row.rows[0]);
}
