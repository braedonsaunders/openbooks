import { NextResponse } from "next/server";
import { runUserSql } from "@openbooks/engine/src/sqlapi.ts";
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
    rawBody = await req.json();
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

  try {
    const result = await runUserSql(body.sql, {
      orgId: gate.user.orgId,
      maxRows: Math.min(Math.max(Math.trunc(Number(body.maxRows)) || 500, 1), 5_000),
      timeoutMs: 10_000,
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "query failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
