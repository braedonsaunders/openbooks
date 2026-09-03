/// <reference types="node" />

/**
 * Behavioral coverage for 0017_document_total_line_invariant -- the storage
 * tie-out between a document's denormalized header totals and its own lines.
 *
 * Before this migration a header that ignored a negative retainage line was
 * silently accepted and then frozen at posting. The ledger, projected from
 * the lines, remained correct while header-driven lists and reports did not.
 *
 * This suite keeps one rejection and one valid control: the historical gross
 * header is rejected after the complete line shape exists; the correct net
 * header commits, posts through the real kernel, and ties to the posted open
 * item. Like every DB-backed suite it self-skips without OPENBOOKS_DB_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

/** Drizzle wraps driver errors (DrizzleQueryError), hiding the PostgreSQL
 * message in `cause`; match the whole rendered chain so a trigger rejection
 * stays assertable. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type EngineDb = typeof import("../engine/src/db.ts");
type EnginePosting = typeof import("../engine/src/posting.ts");
type EngineFixtures = typeof import("../engine/src/test-fixtures.ts");
type Tx = Parameters<Parameters<EngineDb["db"]["transaction"]>[0]>[0];

type Harness = {
  db: EngineDb["db"];
  postDocument: EnginePosting["postDocument"];
  org: Awaited<ReturnType<EngineFixtures["createScratchOrg"]>>;
  retainageAccountId: string;
};

let harness: Harness | null = null;

async function ctx(): Promise<Harness> {
  if (!harness) {
    const [{ db }, { postDocument }, { createScratchOrg }] = await Promise.all([
      import("../engine/src/db.ts"),
      import("../engine/src/posting.ts"),
      import("../engine/src/test-fixtures.ts"),
    ]);
    const org = await createScratchOrg();
    harness = { db, postDocument, org, retainageAccountId: randomUUID() };
  }
  // The tenant fixture is pooled and reset between files, which drops any
  // account this suite added. Re-assert it on every entry rather than only on
  // first construction, or the second test inserts a line referencing an
  // account_id the reset already removed and trips document_lines_account_id_fkey.
  await harness.db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${harness.retainageAccountId}, ${harness.org.orgId}, '1150', 'Retainage Receivable',
            'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    on conflict (id) do nothing`);
  return harness;
}

/** A progress invoice: gross income plus negative retained holdback. */
function progressInvoiceLineSql(
  h: Harness,
  documentId: string,
  actor: string,
): ReturnType<typeof sql>[] {
  return [
    sql`insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, created_by)
        values (${h.org.orgId}, ${documentId}, 1, ${h.org.accounts.revenue}, 'Sov work completed',
                '1', '10000.0000', '10000.0000', ${actor})`,
    sql`insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, created_by)
        values (${h.org.orgId}, ${documentId}, 2, ${h.retainageAccountId}, 'Less retainage held',
                '1', '-1000.0000', '-1000.0000', ${actor})`,
  ];
}

async function insertProgressInvoice(
  h: Harness,
  tx: Tx,
  subtotal: string,
  total: string,
): Promise<string> {
  const id = randomUUID();
  const actor = randomUUID();
  await tx.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, party_id, document_date,
                           currency, subtotal, tax_total, total, created_by)
    values (${id}, ${h.org.orgId}, 'customer_invoice', 'draft', ${`INV-${id.slice(0, 8)}`},
            ${h.org.customerId}, ${h.org.date}, 'CAD', '0', '0', '0', ${actor})`);
  for (const line of progressInvoiceLineSql(h, id, actor)) await tx.execute(line);
  // Match the real construction writer's ordering: draft header, lines, then
  // the list header. The storage line trigger has already derived the net
  // value; a writer that now asserts the old gross value must be rejected.
  await tx.execute(sql`
    update documents
       set subtotal = ${subtotal}, tax_total = '0', total = ${total}
     where id = ${id} and org_id = ${h.org.orgId}`);
  return id;
}

test(
  "a header that ignores the retainage line is rejected at commit, not stored",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const h = await ctx();
    await assert.rejects(
      () =>
        h.db.transaction(async (tx) => {
          await insertProgressInvoice(h, tx, "10000.0000", "10000.0000");
        }),
      (error: unknown) => pgMessage(error).includes("header totals do not tie to its lines"),
    );
    const residue = await h.db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents
       where org_id = ${h.org.orgId} and kind = 'customer_invoice'`);
    assert.equal(residue.rows[0]!.n, 0);
  },
);

test(
  "the correct net header commits, posts through the kernel, and ties to the open item",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const h = await ctx();
    const invoiceId = await h.db.transaction((tx) =>
      insertProgressInvoice(h, tx, "9000.0000", "9000.0000"),
    );

    await h.db.execute(sql`
      update documents set status = 'approved'
       where id = ${invoiceId} and org_id = ${h.org.orgId}`);
    const entryId = await h.postDocument(invoiceId, {
      control: {
        ar: h.org.accounts.ar,
        ap: h.org.accounts.ap,
        bank: h.org.accounts.bank,
      },
    });

    const doc = await h.db.execute<{
      subtotal: string;
      tax_total: string;
      total: string;
    }>(sql`
      select subtotal::text as subtotal, tax_total::text as tax_total, total::text as total
        from documents where id = ${invoiceId} and org_id = ${h.org.orgId}`);
    assert.equal(doc.rows[0]!.subtotal, "9000.0000");
    assert.equal(doc.rows[0]!.tax_total, "0.0000");
    assert.equal(doc.rows[0]!.total, "9000.0000");

    const entry = await h.db.execute<{
      signed_sum: string;
      oi_sum: string;
      debit_sum: string;
      retainage_debit: string;
      income_credit: string;
    }>(sql`
      select coalesce(sum(jl.amount), 0)::text as signed_sum,
             coalesce(sum(jl.amount) filter (where jl.is_open_item), 0)::text as oi_sum,
             coalesce(sum(jl.amount) filter (where jl.amount > 0), 0)::text as debit_sum,
             coalesce(sum(jl.amount) filter (where jl.account_id = ${h.retainageAccountId}
                       and jl.amount > 0), 0)::text as retainage_debit,
             coalesce(sum(jl.amount) filter (where jl.account_id = ${h.org.accounts.revenue}), 0)::text as income_credit
        from journal_lines jl
       where jl.entry_id = ${entryId} and jl.org_id = ${h.org.orgId}`);
    const leg = entry.rows[0]!;
    assert.equal(BigInt(leg.signed_sum.replace(".", "")), 0n);
    assert.equal(leg.retainage_debit, "1000.0000");
    assert.equal(leg.income_credit, "-10000.0000");
    // For an open-item document, total is the collectible AR/AP leg. The
    // debit-side sum is gross (AR + retained receivable), so it is deliberately
    // not the net header total for a retainage invoice.
    assert.equal(leg.oi_sum, doc.rows[0]!.total);
    assert.notEqual(leg.debit_sum, leg.oi_sum);
  },
);

if (DB) {
  test.after(async () => {
    if (!harness) return;
    const { dropScratchOrg } = await import("../engine/src/test-fixtures.ts");
    await dropScratchOrg(harness.org.orgId);
    harness = null;
  });
}
