import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { guardPermission } from "@/lib/authz";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { searchOperatingDepartments } from "@openbooks/engine/organization/operating-profiles";
const Query = z.strictObject({
  family: z.enum(["project", "production"]),
  q: z.string().max(200).optional(),
  selected: uuidString().optional(),
});
export const runtime = "nodejs";
export const GET = defineRoute({
  authorize: async ({ request }) => {
    const family = new URL(request.url).searchParams.get("family");
    if (family !== "project" && family !== "production")
      return NextResponse.json({ error: "Choose project or production." }, { status: 422 });
    return guardPermission(family === "project" ? "projects.read" : "manufacturing.read");
  },
  feature: {
    none: "Native workflow family reads enforce their current feature and department scope.",
  },
  handler: async ({ request, authz }) => {
    const query = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success)
      return NextResponse.json({ error: "Invalid department filters." }, { status: 422 });
    return withOrgTransaction(authz.user.orgId, () =>
      searchOperatingDepartments(
        db,
        authz.user.orgId,
        authz.user.id,
        query.data.family,
        query.data.q,
        query.data.selected,
      ).then((rows) => Response.json(rows)),
    );
  },
});
