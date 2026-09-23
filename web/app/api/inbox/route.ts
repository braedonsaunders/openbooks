import { NextResponse } from "next/server";
import { countInbox, listInbox, type InboxKind, type InboxSourceNotice } from "@openbooks/engine/src/inbox/index.ts";
import { approvalWorklistPageForAuthz } from "../../../lib/application/approvals";
import { getAuthz } from "../../../lib/authz";
import { inboxContext, INBOX_FILTER_KINDS, maySeeUnion } from "../../../lib/inbox-context";
import { pickString } from "../../../lib/list-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTERS = ["all", "approvals", "my_tasks", "signatures", "notices", "overdue"] as const;

/**
 * GET /api/inbox?filter=all|approvals|my_tasks|signatures|notices|overdue[&count=1][&limit=&offset=]
 * — the live inbox read model for the signed-in actor. Core surface (no
 * feature key): every adapter applies its source's own gate, so the list
 * never widens visibility.
 *
 * ?count=1 is the single badge route: pending union decisions plus unread
 * notices. Task items (steps, drafts) wait in the list but do not badge —
 * the badge names decisions and notices only.
 *
 * ?limit/&offset page each source leg (single-kind filters page exactly;
 * multi-kind reads bound each leg). Malformed windows 400 — they never
 * widen into an unbounded read by accident.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const filter = pickString(sp.get("filter") ?? undefined) ?? "all";
  if (!(FILTERS as readonly string[]).includes(filter)) {
    return NextResponse.json({ error: "unknown filter — list one of all, approvals, my_tasks, signatures, notices, overdue" }, { status: 400 });
  }
  const page = parsePage(sp.get("limit"), sp.get("offset"));
  if (page instanceof NextResponse) return page;
  const ctx = await inboxContext(authz);
  try {
    if (sp.get("count") === "1") {
      const [union, unread] = await Promise.all([
        maySeeUnion(authz)
          ? approvalWorklistPageForAuthz(authz, { limit: 1, offset: 0 }).then((page) => page.total)
          : Promise.resolve(0),
        countInbox(ctx, { kinds: ["notification"] }),
      ]);
      return NextResponse.json({ count: union + unread });
    }
    const kinds: InboxKind[] | undefined =
      filter === "all" || filter === "overdue" ? undefined : INBOX_FILTER_KINDS[filter];
    // One failing source names itself in notices while the healthy legs
    // still list (OM-10) — the page renders them beside the surviving rows.
    const notices: InboxSourceNotice[] = [];
    const items = await listInbox(ctx, { ...(kinds ? { kinds } : {}), ...(page ? { page } : {}), notices });
    return NextResponse.json({
      items: filter === "overdue" ? items.filter((i) => i.priority === "overdue") : items,
      notices: notices.map((notice) => ({ source: notice.kind, reason: notice.message })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "the inbox could not be read";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

/** Parse an explicit read window: absent means the full working list. */
function parsePage(limitRaw: string | null, offsetRaw: string | null): { limit?: number; offset?: number } | null | NextResponse {
  if (limitRaw === null && offsetRaw === null) return null;
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return NextResponse.json(
      { error: "limit must be an integer from 1 to 100 and offset a non-negative integer" },
      { status: 400 },
    );
  }
  return { ...(limit === undefined ? {} : { limit }), offset };
}
