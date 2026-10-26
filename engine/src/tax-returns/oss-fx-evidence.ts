import { and, asc, eq } from "drizzle-orm";
import { taxOssFxEvidence } from "@openbooks/schema";
import { db, withOrgTransaction } from "../platform/db.ts";

export async function listOssReturnFxEvidence(
  orgId: string,
  query: { scheme: "union" | "non_union" | "ioss"; from: string; to: string },
) {
  return withOrgTransaction(
    orgId,
    () =>
      db
        .select({
          currency: taxOssFxEvidence.currency,
          rate: taxOssFxEvidence.rate,
          rateAsOf: taxOssFxEvidence.rateAsOf,
          rateSource: taxOssFxEvidence.rateSource,
        })
        .from(taxOssFxEvidence)
        .where(
          and(
            eq(taxOssFxEvidence.orgId, orgId),
            eq(taxOssFxEvidence.scheme, query.scheme),
            eq(taxOssFxEvidence.periodFrom, query.from),
            eq(taxOssFxEvidence.periodTo, query.to),
          ),
        )
        .orderBy(asc(taxOssFxEvidence.currency)),
    { readOnly: true },
  );
}
