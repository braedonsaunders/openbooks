import { defineRoute } from "@/lib/api/route";
import { canApi } from "../../../../lib/api-auth";
import { loadApiSchema } from "../../../../lib/api/schema-registry";
import { withV1Request } from "../../../../lib/api/v1-request";

export const runtime = "nodejs";

/** GET /api/v1/schema — the record-type catalog with live field definitions. */
async function handleV1GET(req: Request) {
  return withV1Request(req, "api/v1/schema", async (auth) => {
    if (!canApi(auth, "api.keys.manage")) {
      return { status: 403, body: { error: "missing permission: api.keys.manage" } };
    }
    return {
      status: 200,
      body: {
        recordTypes: await loadApiSchema(
          auth.user.orgId,
          auth.user.roles.map(({ key }) => key),
        ),
      },
    };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
