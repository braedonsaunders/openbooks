import { NextResponse } from "next/server";
import { listSchema } from "@openbooks/engine/src/platform/sqlapi.ts";
import { defineRoute } from '@/lib/api/route'
import { hasUnrestrictedQueryScope } from "../../../../lib/query-console-access";

/** Live schema browser feed for the SQL console — same read-only role as queries. */
export const GET = defineRoute({
  permission: 'sql.execute',
  feature: 'queryConsole',
  handler: async ({ authz: gate }) => {
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
  },
})
