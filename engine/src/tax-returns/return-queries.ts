import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export type TaxReturnFormRow = {
  code: string;
  name: string;
  country: string | null;
  submission_channel: string;
  government_format: string;
  submission_url: string | null;
  notice_key: string | null;
  has_official: boolean;
};

/** Active tax-return forms configured for an organization. */
export async function listTaxReturnForms(orgId: string): Promise<TaxReturnFormRow[]> {
  return db.execute<TaxReturnFormRow>(
    sql`
      select code, name, country, submission_channel, government_format, submission_url,
             notice_key, official_pdf_file_id is not null as has_official
        from tax_return_forms
       where org_id = ${orgId} and is_active
       order by name
    `,
    "objects",
  );
}

/** Installed tax-return form codes used to plan a library change. */
export async function listInstalledTaxReturnFormCodes(orgId: string): Promise<{ code: string }[]> {
  return db.execute<{ code: string }>(
    sql`select code from tax_return_forms where org_id = ${orgId}`,
    "objects",
  );
}
