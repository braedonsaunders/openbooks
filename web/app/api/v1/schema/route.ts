import { NextResponse } from "next/server";
import { guardApiKey } from "../../../../lib/api-auth";
import { loadApiSchema } from "../../../../lib/api/schema-registry";

export const runtime = "nodejs";

/** GET /api/v1/schema — the record-type catalog with live field definitions. */
export async function GET(req: Request) {
  const gate = await guardApiKey("api.keys.manage", req);
  if (gate instanceof NextResponse) return gate;

  const schema = await loadApiSchema(gate.user.orgId);
  return NextResponse.json({ recordTypes: schema });
}
