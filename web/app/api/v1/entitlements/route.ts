import { defineRoute } from "@/lib/api/route";
import { withV1Request } from "../../../../lib/api/v1-request";
import { getV1Entitlements } from "../../../../lib/application/entitlements";

export const runtime = "nodejs";

/**
 * GET /api/v1/entitlements — effective SaaS entitlements for one customer,
 * served from the cached snapshot. `customer` takes the customer id or the
 * exact customer name; `externalRef` takes `provider:external-id`. Pass
 * `feature` with `used` to evaluate one feature against reported usage
 * (and `subscription` to pin the check when the customer holds several).
 * The application layer refuses the call when advanced subscriptions are
 * off, without leaking whether the customer exists.
 */
async function handleV1GET(request: Request) {
  return withV1Request(request, "api/v1/entitlements", async (_auth, context) => {
    const params = new URL(request.url).searchParams;
    const result = await getV1Entitlements(context, {
      customer: params.get("customer") ?? undefined,
      externalRef: params.get("externalRef") ?? undefined,
      subscription: params.get("subscription") ?? undefined,
      at: params.get("at") ?? undefined,
      feature: params.get("feature") ?? undefined,
      used: params.get("used") ?? undefined,
    });
    return { status: 200, body: result };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
