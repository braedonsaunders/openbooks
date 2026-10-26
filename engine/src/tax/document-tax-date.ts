import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * The date whose tax rates price a document. A credit that corrects an
 * earlier supply adjusts that supply, so it is taxed at the rates in effect
 * on the corrected document's date; every other document is taxed on its
 * own date.
 */
export async function documentTaxDate(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  documentId: string | null,
  documentDate: string,
): Promise<string> {
  if (!documentId) return documentDate;
  const corrected = (
    await runner.execute<{ document_date: string }>(
      sql`
    select corrected.document_date::text as document_date
      from document_links link
      join documents corrected on corrected.org_id = link.org_id and corrected.id = link.to_document_id
     where link.org_id = ${orgId} and link.from_document_id = ${documentId} and link.link_type = 'corrects'
     limit 1`,
      "objects",
    )
  )[0];
  return corrected?.document_date ?? documentDate;
}

export type StaleTaxRateLine = {
  line_number: number;
  code: string;
  stored: string;
  effective: string | null;
};

/**
 * The first calculated tax component whose stored rate differs from the rate
 * in effect on `taxDate`. Stored line tax is kept when only the header
 * changes, so a change of tax date must refuse while any calculated rate
 * would differ; overridden components are the operator's own figures.
 */
export async function staleTaxRateLine(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  documentId: string,
  taxDate: string,
): Promise<StaleTaxRateLine | undefined> {
  return (
    await runner.execute<StaleTaxRateLine>(
      sql`
    select dl.line_number, tc.code, c.rate_percent::text as stored, tr.rate_percent::text as effective
      from document_lines dl
      join document_line_tax_components c on c.document_line_id = dl.id and c.org_id = dl.org_id
      join tax_codes tc on tc.id = c.tax_code_id and tc.org_id = c.org_id
      left join lateral (
        select rate_percent from tax_rates
         where org_id = dl.org_id and tax_code_id = c.tax_code_id and effective_from <= ${taxDate}
           and (effective_to is null or effective_to >= ${taxDate})
         order by effective_from desc limit 1) tr on true
     where dl.org_id = ${orgId} and dl.document_id = ${documentId}
       and not dl.tax_overridden and not c.overridden
       and tr.rate_percent is distinct from c.rate_percent
     order by dl.line_number, c.sequence
     limit 1`,
      "objects",
    )
  )[0];
}
