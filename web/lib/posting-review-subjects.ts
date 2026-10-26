import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

/** Minimal subject identities for API admission before native financial commands. */
export async function invoiceWriteOffSubject(orgId: string, id: string) {
  return (
    (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`
    select subsidiary_id as "subsidiaryId" from documents
    where org_id = ${orgId} and id = ${id} and kind = 'customer_invoice'
  `,
        "objects",
      )
    )[0] ?? null
  );
}

export async function intercompanyPartySubject(orgId: string, id: string) {
  return (
    (
      await db.execute<{ subsidiary_id: string | null }>(
        sql`
    select subsidiary_id from parties where org_id = ${orgId} and id = ${id}
  `,
        "objects",
      )
    )[0] ?? null
  );
}
