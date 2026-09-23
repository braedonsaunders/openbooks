import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import type { PageLayoutPrefs } from "@openbooks/schema";
import { getAuthz } from "../../../../lib/authz";

export const runtime = "nodejs";

/** Stable page keys that accept per-user layout prefs (grow as cockpits adopt it). */
const PAGES = new Set(["banking-cash", "banking-accounts"]);
/** Roster surfaces store row ids (an org can have dozens of card accounts). */
const MAX_KEYS = 300;

/**
 * Lossless wire representation for PostgreSQL's six-digit timestamptz — the
 * house optimistic-concurrency token (insight dashboards/cards use this exact
 * shape), so callers can echo it back without losing precision between a read
 * and a save.
 */
function layoutRevisionSql(column: SQL): SQL<string> {
  return sql<string>`to_char(
    ${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`;
}

const LAYOUT_REVISION_REQUIRED =
  "the page layout revision is required; read the current layout first and send its revision back";
const LAYOUT_REVISION_CONFLICT =
  "this page layout changed after you opened it; the current layout is returned — merge your latest changes onto it and retry";

function keys(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.length <= MAX_KEYS && v.every((k) => typeof k === "string" && k.length <= 64)
    ? (v as string[])
    : undefined;
}

function pageParam(page: unknown): string | null {
  return typeof page === "string" && PAGES.has(page) ? page : null;
}

type LayoutCurrent = { layout: PageLayoutPrefs; revision: string | null };

async function readCurrent(
  execute: (query: SQL) => Promise<{ rows: Array<{ layout: PageLayoutPrefs; revision: string }> }>,
  orgId: string,
  userId: string,
  page: string,
  forUpdate: boolean,
): Promise<LayoutCurrent> {
  const base = sql`
    select layout, ${layoutRevisionSql(sql.raw("updated_at"))} as revision
      from user_page_layouts
     where org_id = ${orgId} and user_id = ${userId} and page = ${page}
     limit 1
  `;
  const rows = (
    await execute(forUpdate ? sql`${base} for update` : base)
  ).rows;
  const row = rows[0];
  if (!row) return { layout: {}, revision: null };
  const layout = row.layout && typeof row.layout === "object" ? row.layout : {};
  return { layout, revision: row.revision };
}

/**
 * Per-user page layout preference (user_page_layouts): GET
 * ?page= returns { layout, revision }; PUT
 * { page, layout: { order?: string[], hidden?: string[] }, expectedRevision }
 * upserts the caller's row. `expectedRevision` is the exact revision token
 * from the last read (null when no row exists yet) — a stale token is a 409
 * carrying the current layout, so an older whole-layout write can never win
 * over a newer one. Layout {} resets to the product default. Self-service
 * like /api/me — any authenticated user, own row only.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;

  const page = pageParam(new URL(req.url).searchParams.get("page"));
  if (!page) {
    return NextResponse.json({ error: "unknown page" }, { status: 400 });
  }

  const current = await readCurrent(
    (query) => db.execute(query),
    user.orgId,
    user.id,
    page,
    false,
  );
  return NextResponse.json(current);
}

export async function PUT(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { user } = authz;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    page?: unknown;
    layout?: { order?: unknown; hidden?: unknown };
    expectedRevision?: unknown;
  } | null;
  const page = pageParam(body?.page);
  if (!page) {
    return NextResponse.json({ error: "unknown page" }, { status: 400 });
  }
  if (body?.expectedRevision === undefined) {
    return NextResponse.json({ error: LAYOUT_REVISION_REQUIRED }, { status: 409 });
  }
  const expectedRevision = body.expectedRevision;
  if (expectedRevision !== null && typeof expectedRevision !== "string") {
    return NextResponse.json(
      { error: "page layout revision must be the exact revision previously read, or null for a first save" },
      { status: 400 },
    );
  }
  const order = keys(body?.layout?.order);
  const hidden = keys(body?.layout?.hidden);
  const layout = { ...(order ? { order } : {}), ...(hidden ? { hidden } : {}) };

  // Lock and compare in the same transaction as the replacement. A slow
  // request can therefore never commit over a newer save that advanced the
  // exact revision while this request was in flight.
  const outcome = await db.transaction(async (tx) => {
    const current = await readCurrent(
      (query) => tx.execute(query),
      user.orgId,
      user.id,
      page,
      true,
    );
    if (current.revision !== expectedRevision) {
      return { kind: "conflict" as const, current };
    }
    const written = await tx.execute<{ layout: PageLayoutPrefs; revision: string }>(sql`
      insert into user_page_layouts (org_id, user_id, page, layout, created_by, updated_by)
      values (${user.orgId}, ${user.id}, ${page}, ${JSON.stringify(layout)}::jsonb, ${user.id}, ${user.id})
      on conflict (org_id, user_id, page)
      do update set layout = excluded.layout,
        updated_at = greatest(clock_timestamp(), user_page_layouts.updated_at + interval '1 microsecond'),
        updated_by = excluded.updated_by
      where user_page_layouts.org_id = ${user.orgId}
      returning layout, ${layoutRevisionSql(sql.raw("updated_at"))} as revision
    `);
    const row = written.rows[0];
    // A write that matches zero rows is a failure, not a save: the locked
    // read above rules out a concurrent deleter, so an empty returning set
    // means the fence itself misfired — refuse rather than report {ok}.
    if (!row) {
      const reread = await readCurrent(
        (query) => tx.execute(query),
        user.orgId,
        user.id,
        page,
        false,
      );
      return { kind: "conflict" as const, current: reread };
    }
    return { kind: "ok" as const, layout: row.layout, revision: row.revision };
  });

  if (outcome.kind === "conflict") {
    return NextResponse.json(
      { error: LAYOUT_REVISION_CONFLICT, current: outcome.current },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, page, layout: outcome.layout, revision: outcome.revision });
}
