import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { sum } from "@openbooks/engine/src/money.ts";
import { can, guardPermission } from "../../../../lib/authz";
import { verifyProposal, type JournalPreview } from "../../../../lib/assistant/proposals";
import { createDraftJournal } from "../../../../lib/journals";

/**
 * The third gate of the propose→confirm→commit pattern (ported from
 * beaconhs's _commit-actions.ts). The user clicked Apply on a proposal card;
 * we re-check the real module permission, verify the HMAC over the exact
 * preview the client returned, and only then write — a DRAFT journal document
 * the user reviews and posts from /journal. The assistant never posts to the
 * ledger.
 */

export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await guardPermission("assistant.write");
  if (gate instanceof NextResponse) return gate;
  const authz = gate;
  if (!can(authz, "gl.post")) {
    return NextResponse.json({ error: "missing permission: gl.post" }, { status: 403 });
  }

  let body: {
    kind?: string;
    preview?: JournalPreview;
    confirmToken?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (body.kind !== "create_journal_entry" || !body.preview || !body.confirmToken) {
    return NextResponse.json({ error: "unsupported draft type" }, { status: 400 });
  }
  if (!verifyProposal("create_journal_entry", body.preview, body.confirmToken, authz)) {
    return NextResponse.json(
      { error: "This draft expired or was modified. Ask the assistant to draft it again." },
      { status: 422 },
    );
  }

  const p = body.preview;
  // Defense in depth: the HMAC already covers a balanced preview, but a
  // balanced check here keeps a signing bug from ever writing a lopsided draft.
  const cents = p.lines.reduce((acc, l) => acc + Math.round(Number(l.amount) * 100), 0);
  if (!Number.isFinite(cents) || cents !== 0 || p.lines.length < 2) {
    return NextResponse.json({ error: "draft lines do not balance" }, { status: 422 });
  }

  const user = authz.user;
  const doc = await createDraftJournal(user.orgId, user.id);
  const totalDebits = sum(p.lines.map((l) => (Number(l.amount) > 0 ? l.amount : "0")));
  await db.transaction(async (tx) => {
    for (let i = 0; i < p.lines.length; i++) {
      const l = p.lines[i]!;
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount)
        values (${user.orgId}, ${doc.id}, ${i + 1}, ${l.accountId}, ${l.description},
                '1', ${l.amount}, ${l.amount})
      `);
    }
    await tx.execute(sql`
      update documents set
        document_date = ${p.documentDate},
        memo = ${p.memo},
        subtotal = ${totalDebits},
        total = ${totalDebits},
        updated_at = now(), updated_by = ${user.id}
      where id = ${doc.id}
    `);
  });

  return NextResponse.json({
    ok: true,
    id: doc.id,
    documentNumber: doc.documentNumber,
    href: `/journal/${doc.id}`,
  });
}
