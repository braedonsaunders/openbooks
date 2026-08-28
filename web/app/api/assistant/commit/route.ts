import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { allocateDocumentNumber } from "@openbooks/engine/src/document-numbering.ts";
import { normalizeMoney, sum, toUnits } from "@openbooks/engine/src/money.ts";
import { can, guardPermission } from "../../../../lib/authz";
import { applicationContextFromSession } from "../../../../lib/application/context";
import { executeIdempotent } from "../../../../lib/application/idempotency";
import { verifyProposal, type JournalPreview } from "../../../../lib/assistant/proposals";
import { canonicalDecimal } from "../../../../lib/exact-decimal";

/** Exact numeric(19,4) money string, or 'invalid'. */
function exactMoney(v: unknown): string | "invalid" {
  const exact = canonicalDecimal(v, 4);
  if (exact === null) return "invalid";
  try {
    return normalizeMoney(exact);
  } catch {
    return "invalid";
  }
}

/**
 * The third gate of the propose→confirm→commit pattern. The user clicked Apply
 * on a proposal card;
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
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data;
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
  const lines: { accountId: string; description: string | null; amount: string }[] = [];
  for (const line of p.lines) {
    const amount = exactMoney(line.amount);
    if (amount === "invalid") {
      return NextResponse.json({ error: "draft lines contain an invalid monetary amount" }, { status: 422 });
    }
    lines.push({ accountId: line.accountId, description: line.description, amount });
  }
  const balance = lines.reduce((acc, line) => acc + toUnits(line.amount), 0n);
  if (balance !== 0n || lines.length < 2) {
    return NextResponse.json({ error: "draft lines do not balance" }, { status: 422 });
  }

  const user = authz.user;
  const totalDebits = sum(lines.map((line) => (toUnits(line.amount) > 0n ? line.amount : "0")));

  // The confirmation token is the durable identity of this proposed write.
  // Claiming it through the application idempotency boundary makes a retry or
  // double-click replay the original response instead of creating another
  // numbered journal. The claim and every journal write share one transaction,
  // so a failed attempt leaves neither an orphan draft nor a consumed token.
  const context = applicationContextFromSession(
    authz,
    "assistant",
    req.headers.get("x-request-id") || randomUUID(),
  );
  const result = await executeIdempotent({
    context,
    operation: "assistant.commit.create_journal_entry",
    idempotencyKey: body.confirmToken,
    request: { kind: body.kind, preview: p },
    execute: () => db.transaction(async (tx) => {
      const root = (await tx.execute<{ id: string; base_currency: string }>(sql`
        select id, base_currency
          from subsidiaries
         where org_id = ${user.orgId}
           and parent_id is null
           and is_active
           and not is_elimination
         order by created_at
         limit 1
      `)).rows[0];
      if (!root) throw new Error("org has no active root subsidiary");

      // Allocate the organization-wide JE number on the same transaction
      // connection as the document. A line or header failure therefore rolls
      // the sequence watermark back along with the draft.
      const documentNumber = await allocateDocumentNumber(tx, user.orgId, "journal", "JE-");
      const inserted = (await tx.execute<{ id: string; document_number: string }>(sql`
        insert into documents (
          org_id, kind, document_number, subsidiary_id, document_date, currency,
          memo, subtotal, tax_total, total, created_by
        )
        values (
          ${user.orgId}, 'journal', ${documentNumber}, ${root.id}, ${p.documentDate},
          ${root.base_currency}, ${p.memo}, ${totalDebits}, '0', ${totalDebits}, ${user.id}
        )
        returning id, document_number
      `));
      const doc = inserted.rows[0];
      if (!doc) throw new Error("journal draft could not be created");

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        await tx.execute(sql`
          insert into document_lines (org_id, document_id, line_number, account_id, description,
                                      quantity, unit_price, amount)
          values (${user.orgId}, ${doc.id}, ${i + 1}, ${l.accountId}, ${l.description},
                  '1', ${l.amount}, ${l.amount})
        `);
      }
      return {
        ok: true as const,
        id: doc.id,
        documentNumber: doc.document_number,
        href: `/journal?entry=${doc.id}`,
      };
    }),
  });

  return NextResponse.json(result.value);
}
