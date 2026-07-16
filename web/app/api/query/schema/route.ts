import { NextResponse } from "next/server";
import { listSchema } from "@openbooks/engine/src/sqlapi.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

/** Live schema browser feed for the SQL console — same read-only role as queries. */
export async function GET() {
  const gate = await guardPermission("sql.execute");
  if (gate instanceof NextResponse) return gate;
  try {
    const tables = await listSchema();
    return NextResponse.json({ tables });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
