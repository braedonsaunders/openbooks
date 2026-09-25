import { canApi } from "../../../../lib/api-auth";
import { generateOpenApiSpec } from "../../../../lib/api/openapi-server";
import { withV1Request } from "../../../../lib/api/v1-request";

export const runtime = "nodejs";

/** GET /api/v1/openapi — the tenant-specific OpenAPI 3.0 spec. */
export async function GET(req: Request) {
  return withV1Request(req, "api/v1/openapi", async (auth) => {
    if (!canApi(auth, "api.keys.manage")) {
      return { status: 403, body: { error: "missing permission: api.keys.manage" } };
    }
    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    const host = req.headers.get("host") ?? "localhost";
    return {
      status: 200,
      body: await generateOpenApiSpec(
        auth.user.orgId,
        `${proto}://${host}`,
        auth.user.roles.map(({ key }) => key),
      ),
    };
  });
}
