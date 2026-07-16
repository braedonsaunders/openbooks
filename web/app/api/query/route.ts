import { NextResponse } from "next/server";
import { runUserSql } from "@openbooks/engine/src/sqlapi.ts";
import { guardPermission } from "../../../lib/authz";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await guardPermission("sql.execute");
  if (gate instanceof NextResponse) return gate;

  const { sql, maxRows } = (await req.json()) as { sql?: string; maxRows?: number };
  if (!sql) return NextResponse.json({ error: "missing sql" }, { status: 400 });
  try {
    const result = await runUserSql(sql, {
      maxRows: Math.min(Math.max(Number(maxRows) || 500, 1), 5_000),
      timeoutMs: 10_000,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
