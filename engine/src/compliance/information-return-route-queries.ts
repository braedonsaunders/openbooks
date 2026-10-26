import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export async function loadInformationReturnExportFiling(orgId: string, filingId: string) {
  const rows = await db.execute<{
    tax_year: number;
    form_type: string;
    currency: string;
    status: string;
    payer_name: string;
  }>(
    sql`
      select f.tax_year, f.form_type, f.currency, f.status,
             coalesce(f.payer_snapshot->>'name', s.name, o.name) as payer_name
        from information_return_filings f
        join orgs o on o.id = f.org_id
        left join subsidiaries s on s.id = f.subsidiary_id and s.org_id = f.org_id
       where f.org_id = ${orgId} and f.id = ${filingId}
    `,
    "objects",
  );
  return rows[0] ?? null;
}

export async function listInformationReturnExportRecipients(orgId: string, filingId: string) {
  return db.execute<{
    name: string;
    display_name: string;
    tin_last4: string | null;
    tin_type: string | null;
    tax_classification: string | null;
    address: Record<string, string | null> | null;
    computed_amounts: Record<string, string>;
    adjustments: Record<string, string>;
    tax_withheld: string;
    corrected: boolean;
  }>(
    sql`
      select coalesce(r.recipient_snapshot->>'legalName', p.display_name) as name,
             p.display_name as display_name,
             r.tin_last4, r.tin_type,
             r.recipient_snapshot->>'taxClassification' as tax_classification,
             r.recipient_snapshot->'address' as address,
             r.computed_amounts, r.adjustments, r.tax_withheld,
             r.corrected_from_id is not null as corrected
        from information_return_recipients r
        join parties p on p.id = r.party_id and p.org_id = r.org_id
       where r.org_id = ${orgId} and r.filing_id = ${filingId} and r.status = 'included'
       order by name
    `,
    "objects",
  );
}
