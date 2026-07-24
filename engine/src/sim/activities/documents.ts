import { sql } from "drizzle-orm";
import { db, schema } from "../../db.ts";
import { postDocument, type PostingDeps } from "../../posting.ts";
import { sum } from "../../money.ts";
import type { SimOrg } from "../world.ts";

/**
 * The create-and-post primitive shared by every document activity. Follows the
 * canonical headless path proven in engine/src/demo-e2e.ts: insert a documents
 * header + document_lines, then call the real postDocument. No shortcut writes to
 * journal_lines — every figure flows through the posting kernel.
 */

export interface DocLine {
  accountId: string;
  description: string;
  /** Positive base-currency amount; sign handling is the posting rule's job. */
  amount: string;
  projectId?: string | null;
}

export interface CreateDocInput {
  kind: string;
  documentNumber: string;
  partyId: string;
  documentDate: string;
  dueDate?: string | null;
  expectedPayDate?: string | null;
  memo?: string | null;
  createdBy: string;
  currency: string;
  lines: DocLine[];
  /** Arbitrary provenance carried on documents.custom. */
  custom?: Record<string, unknown>;
}

/** Build the PostingDeps a document needs from the org's control accounts. */
export function postingDeps(world: SimOrg): PostingDeps {
  return { control: { ar: world.accounts.ar!, ap: world.accounts.ap!, bank: world.accounts.bank! } };
}

/** Insert a document header + lines as a DRAFT (not posted). Returns its id. */
export async function createDraftDocument(world: SimOrg, input: CreateDocInput): Promise<{ documentId: string; total: string }> {
  const total = sum(input.lines.map((l) => l.amount));
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: world.orgId,
      kind: input.kind,
      documentNumber: input.documentNumber,
      partyId: input.partyId,
      documentDate: input.documentDate,
      dueDate: input.dueDate ?? null,
      expectedPayDate: input.expectedPayDate ?? null,
      memo: input.memo ?? null,
      currency: input.currency,
      subtotal: total,
      taxTotal: "0",
      total,
      createdBy: input.createdBy,
      custom: input.custom ?? {},
    })
    .returning();

  await db.insert(schema.documentLines).values(
    input.lines.map((l, i) => ({
      orgId: world.orgId,
      documentId: doc!.id,
      lineNumber: i + 1,
      accountId: l.accountId,
      description: l.description,
      quantity: "1",
      unitPrice: l.amount,
      amount: l.amount,
      taxAmount: "0",
      projectId: l.projectId ?? null,
    })),
  );
  return { documentId: doc!.id, total };
}

/** Post an existing draft document through the real posting kernel. */
export async function postDraftDocument(world: SimOrg, documentId: string): Promise<string> {
  return postDocument(documentId, postingDeps(world));
}

/** Convenience: create a draft and immediately post it (used for JEs / credits). */
export async function createAndPostDocument(
  world: SimOrg,
  input: CreateDocInput,
): Promise<{ documentId: string; entryId: string; total: string }> {
  const { documentId, total } = await createDraftDocument(world, input);
  const entryId = await postDraftDocument(world, documentId);
  return { documentId, entryId, total };
}

/**
 * Open items for a party on one side, with the document's expected-pay-date and
 * sim provenance joined in — enough for the collection/pay-run activities to
 * decide what to settle without re-deriving the open-balance math.
 */
export interface OpenItemRow {
  lineId: string;
  documentId: string;
  kind: string;
  open: string;
  dueDate: string | null;
  expectedPayDate: string | null;
  custom: Record<string, unknown>;
}

export async function collectibleOpenItems(
  orgId: string,
  partyId: string,
  side: "ar" | "ap",
  kindsOverride?: string[],
): Promise<OpenItemRow[]> {
  const kinds = kindsOverride ?? (side === "ar" ? ["customer_invoice", "customer_credit"] : ["vendor_bill", "vendor_credit"]);
  const rows = (await db.execute(sql`
    with lines as (
      select l.id as line_id, d.id as document_id, d.kind, d.due_date, d.expected_pay_date, d.custom, l.amount,
             coalesce((
               select sum(a.amount) from applications a
                where (a.to_line_id = l.id or a.from_line_id = l.id) and a.unapplied_at is null
             ), 0) as applied
        from documents d
        join journal_lines l on l.entry_id = d.posted_entry_id and l.is_open_item
       where d.org_id = ${orgId} and d.party_id = ${partyId} and d.status = 'posted'
         and d.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
    )
    select line_id, document_id, kind, due_date, expected_pay_date, custom,
           (abs(amount) - applied)::text as open
      from lines
     where abs(amount) - applied > 0.005`)) as unknown as {
    rows: { line_id: string; document_id: string; kind: string; due_date: string | null; expected_pay_date: string | null; custom: Record<string, unknown>; open: string }[];
  };
  return rows.rows.map((r) => ({
    lineId: r.line_id,
    documentId: r.document_id,
    kind: r.kind,
    open: r.open,
    dueDate: r.due_date,
    expectedPayDate: r.expected_pay_date,
    custom: r.custom ?? {},
  }));
}
