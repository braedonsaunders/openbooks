import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { getAuthz } from "../../../../lib/authz";
import { RECORD_TYPE_BY_KEY } from "@openbooks/customization";
import { refuseDisabledRecordType } from "../../../../lib/customization/gates";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/** Same accessibility rule resolveFormLayout uses: empty/null ⇒ everyone. */
function rowIsAccessible(allowedRoles: string[] | null, userRoles: string[]): boolean {
  if (!allowedRoles || allowedRoles.length === 0) return true;
  return allowedRoles.some((role) => userRoles.includes(role));
}

/**
 * PUT /api/customization/form-preferences — set the signed-in user's preferred
 * form for a record type. Self-service (any authenticated user). Body:
 *   { recordType, layoutId?: string | null }
 * layoutId null ⇒ inherit the org default.
 */
export async function PUT(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    recordType?: string;
    layoutId?: string | null;
  };
  if (!body.recordType || !RECORD_TYPE_BY_KEY[body.recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const refused = await refuseDisabledRecordType(user.orgId, body.recordType);
  if (refused) return refused;
  const layoutId = body.layoutId ?? null;
  // A malformed id would surface as a Postgres uuid throw and a raw 500;
  // resolve it through the same 404 as an unknown layout.
  if (layoutId && !isUuid(layoutId)) {
    return NextResponse.json({ error: "form layout not found" }, { status: 404 });
  }
  if (layoutId) {
    // The preferred form must be one resolveFormLayout would actually apply:
    // in-org, matching record type, is_active, and role-accessible (admins
    // bypass). Saving an inactive or role-restricted form used to return
    // {ok:true} while resolve dropped it, so the save had no observable effect.
    const owned = (await db.execute<{
      isActive: boolean;
      allowedRoles: string[] | null;
    }>(sql`
      select is_active as "isActive", allowed_roles as "allowedRoles"
        from form_layouts
       where id = ${layoutId} and org_id = ${user.orgId} and record_type = ${body.recordType}
    `));
    const row = owned.rows[0];
    if (!row) return NextResponse.json({ error: "form layout not found" }, { status: 404 });
    if (!row.isActive) {
      return NextResponse.json(
        {
          error:
            "form layout is inactive — activate it in Customization, or choose an active form",
        },
        { status: 422 },
      );
    }
    const userRoles = (user.roles ?? []).map((role) => role.key);
    if (!(rowIsAccessible(row.allowedRoles, userRoles) || userRoles.includes("admin"))) {
      return NextResponse.json(
        {
          error:
            "form layout is restricted to other roles — choose a form available to your role, or ask an administrator to grant your role access",
        },
        { status: 403 },
      );
    }
  }
  await db.execute(sql`
    insert into user_form_preferences (org_id, user_id, record_type, layout_id, created_by, updated_by)
    values (${user.orgId}, ${user.id}, ${body.recordType}, ${layoutId}, ${user.id}, ${user.id})
    on conflict (org_id, user_id, record_type) do update
      set layout_id = excluded.layout_id, updated_at = now(), updated_by = ${user.id}
    where user_form_preferences.org_id = ${user.orgId}`);
  return NextResponse.json({ ok: true, layoutId });
}
