import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { listAccountMerges } from "@openbooks/engine/chart/account-merge";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/** Executed account merges and open merge proposals, newest first. */
export const GET = defineRoute({
  permission: "gl.read",
  feature: "accountMerges",
  handler: async ({ request, authz }) => {
    const url = new URL(request.url);
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const perPage = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get("perPage") ?? "50", 10) || 50),
    );
    const account = url.searchParams.get("account");
    if (account && !isUuid(account)) {
      return NextResponse.json({ error: "Choose a valid account." }, { status: 422 });
    }
    return NextResponse.json(
      await listAccountMerges(
        authz.user.orgId,
        { limit: perPage, offset: (page - 1) * perPage, accountId: account || null },
        authz.allowedSubsidiaryIds,
      ),
    );
  },
});
