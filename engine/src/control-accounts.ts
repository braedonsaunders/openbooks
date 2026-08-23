import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/** Org-level control accounts from orgs.settings.controlAccounts — posting-rule deps. */
export interface OrgControlAccounts {
  ar?: string;
  ap?: string;
  bank?: string;
  taxCollected?: string;
  taxPaid?: string;
  employeePayable?: string;
}

/** Single reader of orgs.settings.controlAccounts for posting-rule deps. */
export async function loadControlAccounts(orgId: string): Promise<OrgControlAccounts> {
  const r = (await db.execute<{ c: OrgControlAccounts | null }>(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  ));
  const c = r.rows[0]?.c ?? {};
  return {
    ar: c.ar,
    ap: c.ap,
    bank: c.bank,
    taxCollected: c.taxCollected,
    taxPaid: c.taxPaid,
    employeePayable: c.employeePayable,
  };
}

/** Control accounts shaped for PostingDeps: ar/ap/bank are mandatory before
 * any document may post. Fails closed on incomplete org configuration
 * instead of letting undefined account ids reach the posting kernel. */
export async function loadRequiredControlAccounts(orgId: string): Promise<
  Required<Pick<OrgControlAccounts, "ar" | "ap" | "bank">> &
    Pick<OrgControlAccounts, "taxCollected" | "taxPaid" | "employeePayable">
> {
  const c = await loadControlAccounts(orgId);
  if (!c.ar || !c.ap || !c.bank) {
    throw new Error(
      `org ${orgId} control accounts are incomplete: ar, ap, and bank must be configured in orgs.settings.controlAccounts before posting`,
    );
  }
  return {
    ar: c.ar,
    ap: c.ap,
    bank: c.bank,
    taxCollected: c.taxCollected,
    taxPaid: c.taxPaid,
    employeePayable: c.employeePayable,
  };
}
