import { NextResponse } from "next/server";
import { guardApiKey } from "../../../../lib/api-auth";
import { generateOpenApiSpec } from "../../../../lib/api/openapi-server";
import { emitV1ExecutionEvent } from "../../../../lib/api/v1-request";

export const runtime = "nodejs";

/** GET /api/v1/openapi — the tenant-specific OpenAPI 3.0 spec. */
export async function GET(req: Request) {
  const gate = await guardApiKey("api.keys.manage", req);
  if (gate instanceof NextResponse) return gate;

  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost";
  const spec = await generateOpenApiSpec(
    gate.user.orgId,
    `${proto}://${host}`,
    gate.user.roles.map(({ key }) => key),
  );
  const auditFailure = await emitV1ExecutionEvent("v1.openapi", 200, gate);
  if (auditFailure) return auditFailure;
  return NextResponse.json(spec);
}
