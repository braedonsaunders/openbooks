import { NextResponse } from "next/server";
import { countInbox, listInbox, type InboxKind } from "@openbooks/engine/src/inbox/index.ts";
import { approvalWorklistPageForAuthz } from "../../../lib/application/approvals";
import { getAuthz } from "../../../lib/authz";
import { inboxContext, maySeeUnion } from "../../../lib/inbox-context";
import { INBOX_FILTER_KINDS } from "./act/route";
import { pickString } from "../../../lib/list-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTERS = ["all", "approvals", "my_tasks", "signatures", "notices", "overdue"] as const;

/**
 * GET /api/inbox?filter=all|approvals|my_tasks|signatures|notices|overdue[&count=1]
 * — the live inbox read model for the signed-in actor. Core surface (no
 * feature key): every adapter applies its source's own gate, so the list
 * never widens visibility.
 *
 * ?count=1 is the single badge route: pending union decisions plus unread
 * notices. Task items (steps, drafts) wait in the list but do not badge —
 * the badge names decisions and notices only.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const filter = pickString(sp.get("filter") ?? undefined) ?? "all";
  if (!(FILTERS as readonly string[]).includes(filter)) {
    return NextResponse.json({ error: "unknown filter — list one of all, approvals, my_tasks, signatures, notices, overdue" }, { status: 400 });
  }
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
    const items = await listInbox(ctx, kinds ? { kinds } : undefined);
    return NextResponse.json({
      items: filter === "overdue" ? items.filter((i) => i.priority === "overdue") : items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "the inbox could not be read";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
