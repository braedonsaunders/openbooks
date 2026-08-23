import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { getAuthz } from "../../../../lib/authz";

export const runtime = "nodejs";

/** Stable page keys that accept per-user layout prefs (grow as cockpits adopt it). */
const PAGES = new Set(["banking-cash", "banking-accounts"]);
/** Roster surfaces store row ids (an org can have dozens of card accounts). */
const MAX_KEYS = 300;

/**
 * Per-user page layout preference (user_page_layouts): PUT
 * { page, layout: { order?: string[], hidden?: string[] } } upserts the
 * caller's row; layout {} resets to the product default. Self-service like
 * /api/me — any authenticated user, own row only.
 */
export async function PUT(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    page?: unknown;
    layout?: { order?: unknown; hidden?: unknown };
  } | null;
  const page = body?.page;
  if (typeof page !== "string" || !PAGES.has(page)) {
    return NextResponse.json({ error: "unknown page" }, { status: 400 });
  }
  const keys = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length <= MAX_KEYS && v.every((k) => typeof k === "string" && k.length <= 64)
      ? (v as string[])
      : undefined;
  const order = keys(body?.layout?.order);
  const hidden = keys(body?.layout?.hidden);
  const layout = { ...(order ? { order } : {}), ...(hidden ? { hidden } : {}) };

  await db.execute(sql`
    insert into user_page_layouts (org_id, user_id, page, layout, created_by, updated_by)
    values (${user.orgId}, ${user.id}, ${page}, ${JSON.stringify(layout)}::jsonb, ${user.id}, ${user.id})
    on conflict (org_id, user_id, page)
    do update set layout = excluded.layout, updated_at = now(), updated_by = excluded.updated_by
    where user_page_layouts.org_id = ${user.orgId}
  `);

  return NextResponse.json({ ok: true, page, layout });
}
