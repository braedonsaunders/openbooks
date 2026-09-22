import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../../lib/api/v1-request";
import { getApplicationCrmAccount } from "../../../../../../lib/application/crm-read";

export const runtime = "nodejs";

/** GET /api/v1/crm/accounts/{id} — one CRM account through the drawer loader. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/crm/accounts/[id]", async (_auth, context) => {
    const { id } = await params;
    return { status: 200, body: await getApplicationCrmAccount(context, id) };
  });
}
