import { NextResponse } from "next/server";
import { listSchema } from "@openbooks/engine/src/sqlapi.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { hasUnrestrictedQueryScope } from "../../../../lib/query-console-access";

export const runtime = "nodejs";

/** Live schema browser feed for the SQL console — same read-only role as queries. */
export async function GET() {
  let gate: Awaited<ReturnType<typeof guardFeaturePermission>>;
  try {
    gate = await guardFeaturePermission("sql.execute", "queryConsole");
  } catch (error) {
    console.error("[query-console] schema authorization failed", error);
    return NextResponse.json({ error: "query service unavailable" }, { status: 500 });
  }
  if (gate instanceof NextResponse) return gate;
  if (!hasUnrestrictedQueryScope(gate.allowedSubsidiaryIds)) {
    return NextResponse.json(
      { error: "query console requires unrestricted subsidiary access" },
      { status: 403 },
    );
  }
  try {
    const tables = await listSchema(gate.user.orgId);
    return NextResponse.json({ tables });
  } catch (error) {
    console.error("[query-console] schema discovery failed", error);
    return NextResponse.json({ error: "query schema unavailable" }, { status: 500 });
  }
}
