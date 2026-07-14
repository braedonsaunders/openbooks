import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { submitForApproval, decide } from "@openbooks/engine/src/approvals.ts";
import { postDocument, PostingError } from "@openbooks/engine/src/posting.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

const ACTION_PERMISSION = {
  submit: "ar.create",
  decide: "ar.approve",
  post: "ar.post",
} as const;

async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any;
  const c = r.rows[0]?.c ?? {};
  return { control: { ar: c.ar, ap: c.ap, bank: c.bank, taxCollected: c.taxCollected, taxPaid: c.taxPaid } };
}

/** The document must be a customer invoice in the caller's org. */
async function assertInvoice(documentId: string, orgId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from documents where id = ${documentId} and kind = 'customer_invoice' and org_id = ${orgId}`,
  )) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action: "submit" | "decide" | "post";
    documentId?: string;
    requestId?: string; stepNumber?: number; decision?: "approved" | "rejected"; note?: string;
  };

  const permission = ACTION_PERMISSION[body.action];
  if (!permission) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  const gate = await guardPermission(permission);
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  try {
    switch (body.action) {
      case "submit": {
        if (!(await assertInvoice(body.documentId!, user.orgId))) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        const requestId = await submitForApproval("customer_invoice", body.documentId!);
        return NextResponse.json({ ok: true, requestId });
      }
      case "decide": {
        const res = await decide(body.requestId!, body.stepNumber!, body.decision!, user.id, body.note);
        return NextResponse.json({ ok: true, ...res });
      }
      case "post": {
        if (!(await assertInvoice(body.documentId!, user.orgId))) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        const deps = await controlDeps(user.orgId);
        const entryId = await postDocument(body.documentId!, deps);
        return NextResponse.json({ ok: true, entryId });
      }
    }
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
