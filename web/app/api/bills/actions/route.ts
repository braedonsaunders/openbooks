import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { submitForApproval, decide } from "@openbooks/engine/src/approvals.ts";
import { postDocument, PostingError } from "@openbooks/engine/src/posting.ts";
import { reopenDocument, ReopenError } from "@openbooks/engine/src/document-edit.ts";
import { currentUser } from "../../../../lib/auth";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any;
  const c = r.rows[0]?.c ?? {};
  return { control: { ar: c.ar, ap: c.ap, bank: c.bank, taxCollected: c.taxCollected, taxPaid: c.taxPaid } };
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as {
    action: "submit" | "decide" | "post" | "reopen";
    documentId?: string;
    requestId?: string; stepNumber?: number; decision?: "approved" | "rejected"; note?: string;
  };

  try {
    switch (body.action) {
      case "reopen": {
        const gate = await guardPermission("ap.create");
        if (gate instanceof NextResponse) return gate;
        const owned = (await db.execute(sql`
          select id from documents
           where id = ${body.documentId ?? null} and kind = 'vendor_bill' and org_id = ${user.orgId}
        `)) as unknown as { rows: { id: string }[] };
        if (!owned.rows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
        const res = await reopenDocument(body.documentId!, user.id);
        return NextResponse.json({ ok: true, id: res.documentId });
      }
      case "submit": {
        const requestId = await submitForApproval("vendor_bill", body.documentId!);
        return NextResponse.json({ ok: true, requestId });
      }
      case "decide": {
        // Decisions go through the neutral /api/approvals/decide endpoint
        // (permission-gated by target kind). Kept here only as a guarded
        // fallback for any direct caller.
        const gate = await guardPermission("ap.approve");
        if (gate instanceof NextResponse) return gate;
        const res = await decide(body.requestId!, body.stepNumber!, body.decision!, user.id, body.note);
        return NextResponse.json({ ok: true, ...res });
      }
      case "post": {
        const deps = await controlDeps(user.orgId);
        const entryId = await postDocument(body.documentId!, deps);
        return NextResponse.json({ ok: true, entryId });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    const status = e instanceof PostingError || e instanceof ReopenError ? 422 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
