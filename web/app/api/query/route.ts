import { NextResponse } from "next/server";
import { runUserSql } from "@openbooks/engine/src/sqlapi.ts";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { sql } = (await req.json()) as { sql?: string };
  if (!sql) return NextResponse.json({ error: "missing sql" }, { status: 400 });
  try {
    const result = await runUserSql(sql, { maxRows: 500, timeoutMs: 10_000 });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
