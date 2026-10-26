import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { intercompanyPartySubject } from "@/lib/posting-review-subjects";
import { subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import { intercompanyRepresentationsOfParty } from "@openbooks/engine/intercompany";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const query = z.object({ partyId: uuidString() });

/** The subsidiaries a visible party represents as intercompany customer or vendor. */
export const GET = defineRoute({
  permission: "parties.read",
  feature: "intercompanyTransactions",
  handler: async ({ request, authz }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      return NextResponse.json({ error: "a party id is required" }, { status: 400 });
    const party = await intercompanyPartySubject(authz.user.orgId, parsed.data.partyId);
    if (
      !party ||
      !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, party.subsidiary_id, { orgWideNull: true })
    ) {
      return notFound("record");
    }
    return NextResponse.json({
      representations: await intercompanyRepresentationsOfParty(
        authz.user.orgId,
        parsed.data.partyId,
      ),
    });
  },
});
