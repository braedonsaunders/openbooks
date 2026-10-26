import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import type { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";

export type OpeningLevySourceCorrection = {
  requestId: string;
  expectedAuthorityId: string;
  expectedAllocationSha256: string;
};

/** A certificate head is resolved from retained successors, never by modifying history. */
export function currentOpeningLevySourceSql(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias))
    throw new PayrollError("Resolve the opening certificate with a native SQL alias");
  const column = (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  return sql`not exists (select 1 from payroll_opening_levy_source_authorities successor
    where successor.org_id=${column("org_id")} and successor.supersedes_authority_id=${column("id")})`;
}

export function openingLevySourceCorrectionRequestSha256(
  correction: OpeningLevySourceCorrection,
  payload: Record<string, unknown>,
): string {
  if (
    ![correction.requestId, correction.expectedAuthorityId].every(isUuid) ||
    !/^[a-f0-9]{64}$/.test(correction.expectedAllocationSha256)
  ) {
    throw new PayrollError(
      "Reload the sealed opening certificate and its allocation digest before correcting its source",
    );
  }
  return createHash("sha256")
    .update(canonicalJson({ version: 1, correction, payload }))
    .digest("hex");
}

/** Amounts already represented by live payroll or any issued artifact cannot be requalified. */
export async function requireUnconsumedOpeningLevySource(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    taxYear: number;
    subsidiaryId: string;
    employeePartyId: string;
    openingBalanceId: string;
    authorityId: string;
  },
): Promise<void> {
  const consumed = await tx.execute(
    sql`
    select r.document_id from pay_runs r
      join documents d on d.org_id=r.org_id and d.id=r.document_id
     where r.org_id=${input.orgId} and r.tax_year=${input.taxYear}
       and d.status<>'voided' and r.run_status='committed'
       and (coalesce(r.calculation_source_snapshot,'{}'::jsonb) @> jsonb_build_object(
         'openingLevySourceAuthorities',jsonb_build_array(jsonb_build_object('id',${input.authorityId}::text)))
         or coalesce(r.calculation_source_snapshot,'{}'::jsonb) @> jsonb_build_object(
           'openingBalanceSources',jsonb_build_array(jsonb_build_object('openingBalanceId',${input.openingBalanceId}::text)))
         or d.subsidiary_id=${input.subsidiaryId}
         or exists (select 1 from pay_stubs s where s.org_id=r.org_id and s.pay_run_document_id=r.document_id
           and s.employee_party_id=${input.employeePartyId}))
     limit 1
  `,
    "objects",
  );
  if (consumed.length)
    throw new PayrollError(
      "Committed payroll retains this opening source; complete its native governed void before correcting the certificate, then calculate its replacement from the corrected source",
    );
  const issued = await tx.execute(
    sql`
    select id from payroll_filing_submissions where org_id=${input.orgId} and tax_year=${input.taxYear} limit 1
  `,
    "objects",
  );
  if (issued.length)
    throw new PayrollError(
      "An issued payroll filing retains history for this tax year; preserve its original source certificate and artifacts. Source certificate replacement for an issued year is unavailable",
    );
}
