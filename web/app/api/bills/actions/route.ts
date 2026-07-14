import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { submitForApproval, decide } from "@openbooks/engine/src/approvals.ts";
import { postDocument, PostingError } from "@openbooks/engine/src/posting.ts";
import { currentUser } from "../../../../lib/auth";

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
    action: "submit" | "decide" | "post";
    documentId?: string;
    requestId?: string; stepNumber?: number; decision?: "approved" | "rejected"; note?: string;
  };

  try {
    switch (body.action) {
      case "submit": {
        const requestId = await submitForApproval("vendor_bill", body.documentId!);
        return NextResponse.json({ ok: true, requestId });
      }
      case "decide": {
        if (!["controller", "admin"].includes(user.role)) {
          return NextResponse.json({ error: "your role cannot approve" }, { status: 403 });
        }
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
    const status = e instanceof PostingError ? 422 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
