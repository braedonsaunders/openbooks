import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { db, withOrgContext } from "@openbooks/engine/platform/database";
import { isUuid } from "@/lib/list-params";
import { guardChannelScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

/** Active stock locations as mapping options, labelled with their dimension name. */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    const rows = (
      await withOrgContext(gate.user.orgId, () =>
        db.execute<{ value: string; label: string }>(sql`
          select sl.id as value, concat_ws(' ', nullif(l.name, ''), concat('(', sl.code, ')')) as label
            from stock_locations sl
            join locations l on l.org_id = sl.org_id and l.id = sl.location_id
           where sl.org_id = ${gate.user.orgId} and sl.is_active
           order by l.name, sl.code limit 2000`),
      )
    ).rows;
    return NextResponse.json({ options: rows });
  },
});
