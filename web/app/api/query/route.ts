import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { runUserSql, validateUserSql } from "@openbooks/engine/src/sqlapi.ts";
import { guardFeaturePermission } from "../../../lib/feature-gates";
import { hasUnrestrictedQueryScope } from "../../../lib/query-console-access";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let gate: Awaited<ReturnType<typeof guardFeaturePermission>>;
  try {
    gate = await guardFeaturePermission("sql.execute", "queryConsole");
  } catch (error) {
    console.error("[query-console] authorization failed", error);
    return NextResponse.json({ error: "query service unavailable" }, { status: 500 });
  }
  if (gate instanceof NextResponse) return gate;
  if (!hasUnrestrictedQueryScope(gate.allowedSubsidiaryIds)) {
    return NextResponse.json(
      { error: "query console requires unrestricted subsidiary access" },
      { status: 403 },
    );
  }

  let rawBody: unknown;
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    rawBody = parsedBody.data;
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "request body must be a JSON object" }, { status: 400 });
  }
  const body = rawBody as { sql?: unknown; maxRows?: unknown };
  if (typeof body.sql !== "string" || !body.sql.trim()) {
    return NextResponse.json({ error: "missing sql" }, { status: 400 });
  }

  // Pure pre-validation: its messages are schema-free ("one statement per
  // query", "read-only: …") and safe to echo. Anything thrown past this point
  // is a real PostgreSQL error and must not leak relation/column names.
  try {
    validateUserSql(body.sql);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid query" },
      { status: 400 },
    );
  }

  try {
    const result = await runUserSql(body.sql, {
      orgId: gate.user.orgId,
      maxRows: Math.min(Math.max(Math.trunc(Number(body.maxRows)) || 500, 1), 5_000),
      // An analyst console over a real ledger runs genuine aggregate scans;
      // ten seconds cancelled ordinary work on a large tenant.
      timeoutMs: 30_000,
    });
    return NextResponse.json(result);
  } catch (e) {
    // Full error stays in the server log only; the client gets a generic
    // message so database internals never reach the browser.
    console.error("[query-console] execution failed", e);
    return NextResponse.json({ error: "query failed" }, { status: 400 });
  }
}
