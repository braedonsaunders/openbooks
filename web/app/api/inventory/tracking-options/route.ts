import { z } from "zod";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/database";
import { defineRoute } from "@/lib/api/route";
import { uuidId } from "@/lib/api/json";
const query = z
  .object({
    itemId: uuidId,
    q: z.string().max(200).optional(),
    lotId: uuidId.optional(),
  })
  .strict();
export const GET = defineRoute({
  permission: "items.read",
  feature: "inventory",
  handler: async ({ request, authz }) => {
    const parsed = query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      return NextResponse.json(
        { error: "Choose a valid inventory item" },
        { status: 422 },
      );
    const { itemId, q, lotId } = parsed.data;
    const profile = (
      await db.execute<{ tracking: string }>(
        sql`select tracking from item_inventory_profiles where org_id=${authz.user.orgId} and item_id=${itemId}`,
      )
    ).rows[0];
    if (!profile)
      return NextResponse.json(
        {
          error:
            "Item has no inventory profile — configure its costing and tracking before selecting identifiers",
        },
        { status: 422 },
      );
    const lots = (
      await db.execute(sql`select id,lot_number as label,expires_on::text as expiry,hold_reason from lots
   where org_id=${authz.user.orgId} and item_id=${itemId} and lot_number ilike ${`%${q ?? ""}%`} order by expires_on nulls last,lot_number limit 100`)
    ).rows;
    const serials = (
      await db.execute(sql`select id,serial_number as label,lot_id,hold_reason from serials
   where org_id=${authz.user.orgId} and item_id=${itemId} and serial_number ilike ${`%${q ?? ""}%`}
     ${lotId ? sql`and (lot_id=${lotId} or lot_id is null)` : sql``} order by serial_number limit 100`)
    ).rows;
    return NextResponse.json({ tracking: profile.tracking, lots, serials });
  },
});
