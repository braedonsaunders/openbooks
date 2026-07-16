/**
 * One-time backfill: recompute documents.subtotal / tax_total / total for records
 * whose header totals were never populated (the native importer inserted the
 * header + document_lines but left the schema-default 0 on the money columns).
 *
 * The correct magnitude of a POSTED document is the sum of the positive
 * (debit) lines of its journal entry — the GL truth, which equals a natively
 * created document's stored total. Tax is the (absolute) sum of the document's
 * line tax; subtotal = total − tax. Non-posting orders/quotes have no entry, so
 * their total comes straight from their lines.
 *
 *   npx tsx engine/src/backfill-document-totals.mts          # apply
 *   npx tsx engine/src/backfill-document-totals.mts --dry    # report only
 *
 * Idempotent: re-running recomputes the same values.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";

const DRY = process.argv.includes("--dry");

async function main() {
  const before = (await db.execute(sql`
    select
      count(*) filter (where total = 0) as zero_total,
      count(*) as n
    from documents
  `)) as any;
  console.log(`before: ${before.rows[0].zero_total} / ${before.rows[0].n} documents have total = 0`);

  if (DRY) {
    // Show what the posted-doc backfill WOULD write for a sample.
    const sample = (await db.execute(sql`
      select d.kind, d.document_number, d.total as old_total,
             coalesce(j.pos, 0) as new_total,
             coalesce(abs(lt.tax), 0) as new_tax
        from documents d
        left join lateral (
          select sum(jl.amount) filter (where jl.amount > 0) as pos
            from journal_lines jl where jl.entry_id = d.posted_entry_id) j on true
        left join lateral (
          select sum(l.tax_amount) as tax from document_lines l where l.document_id = d.id) lt on true
       where d.posted_entry_id is not null and d.total = 0
       order by random() limit 10
    `)) as any;
    console.table(sample.rows);
    await pool.end();
    return;
  }

  // 1. Posted documents: total = Σ positive journal lines (GL magnitude).
  const posted = (await db.execute(sql`
    update documents d set
      total = coalesce(j.pos, 0),
      tax_total = coalesce(abs(lt.tax), 0),
      subtotal = coalesce(j.pos, 0) - coalesce(abs(lt.tax), 0),
      updated_at = now()
    from documents d2
    left join lateral (
      select sum(jl.amount) filter (where jl.amount > 0) as pos
        from journal_lines jl where jl.entry_id = d2.posted_entry_id) j on true
    left join lateral (
      select sum(l.tax_amount) as tax from document_lines l where l.document_id = d2.id) lt on true
    where d.id = d2.id and d2.posted_entry_id is not null
  `)) as any;
  console.log(`posted documents updated:      ${posted.rowCount ?? "?"}`);

  // 2. Non-posting orders/quotes/drafts: total straight from the lines.
  const unposted = (await db.execute(sql`
    update documents d set
      subtotal = coalesce(abs(lt.amt), 0),
      tax_total = coalesce(abs(lt.tax), 0),
      total = coalesce(abs(lt.amt), 0) + coalesce(abs(lt.tax), 0),
      updated_at = now()
    from (
      select document_id, sum(amount) as amt, sum(tax_amount) as tax
        from document_lines group by document_id) lt
    where lt.document_id = d.id and d.posted_entry_id is null
  `)) as any;
  console.log(`non-posting documents updated: ${unposted.rowCount ?? "?"}`);

  const after = (await db.execute(sql`
    select count(*) filter (where total = 0) as zero_total, count(*) as n from documents
  `)) as any;
  console.log(`after:  ${after.rows[0].zero_total} / ${after.rows[0].n} documents have total = 0`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
