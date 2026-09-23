import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
// Relative (not the bare workspace specifier): worktree node_modules resolves
// bare @openbooks/* to the main checkout, so a relative import binds this
// checkout everywhere.
import { ACCOUNT_CLASS_TYPES } from "../../../engine/src/records/account-types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The single asset type that counts as a bank account for the register. */
export const BANK_ACCOUNT_TYPE = "asset_bank";
/** The single liability type that counts as a card account for the cycle. */
export const CARD_ACCOUNT_TYPE = "liability_card";

// The singletons above must sit in their canonical classes; fail fast at
// load if the canonical map ever moves them.
const assetTypes = ACCOUNT_CLASS_TYPES.asset as readonly string[];
const liabilityTypes = ACCOUNT_CLASS_TYPES.liability as readonly string[];
if (!assetTypes.includes(BANK_ACCOUNT_TYPE)) {
  throw new Error(`canonical account classes moved ${BANK_ACCOUNT_TYPE} out of asset`);
}
if (!liabilityTypes.includes(CARD_ACCOUNT_TYPE)) {
  throw new Error(`canonical account classes moved ${CARD_ACCOUNT_TYPE} out of liability`);
}

export interface ReferenceSpec {
  /** Request field name, used to name the refusal (e.g. "bankAccountIds"). */
  field: string;
  table: "accounts" | "parties";
  /** Human kind for the message (e.g. "an account", "a party"). */
  kind: string;
  ids: string[];
  /** Null = unrestricted caller: no subsidiary check. */
  allowedSubsidiaryIds: Set<string> | null;
  /** Require an exact account type (bank / card accounts). */
  expectAccountType?: typeof BANK_ACCOUNT_TYPE | typeof CARD_ACCOUNT_TYPE;
  /** Require a postable, non-summary account (GL history sources). */
  expectPostable?: boolean;
  /** Require a vendor role (vendor methods read vendors). */
  expectVendorRole?: boolean;
}

type AccountRow = {
  id: string;
  type: string;
  is_summary: boolean;
  subsidiary_id: string | null;
};

type PartyRow = {
  id: string;
  is_vendor: boolean;
  subsidiary_id: string | null;
};

async function checkAccounts(orgId: string, spec: ReferenceSpec): Promise<string | null> {
  for (const id of spec.ids) {
    if (!UUID_RE.test(id)) return `${spec.field} "${id}" is not a valid UUID`;
  }
  if (!spec.ids.length) return null;
  // House array idiom (see web/lib/billing.ts): a Postgres array literal,
  // never a bare JS array (drizzle binds those as row constructors). Safe to
  // interpolate: every id passed the UUID shape above (hex and dashes only).
  const rows = await db.execute<AccountRow>(sql`
    select id::text as id, type, is_summary, subsidiary_id::text as subsidiary_id
      from accounts
     where org_id = ${orgId} and id = any(${`{${spec.ids.join(",")}}`}::uuid[])
  `);
  const found = new Map(rows.rows.map((row) => [row.id.toLowerCase(), row]));
  for (const id of spec.ids) {
    const row = found.get(id.toLowerCase());
    if (!row) return `${spec.field} "${id}" is not ${spec.kind} in this organization`;
    // Org-wide (null-subsidiary) accounts are visible to restricted callers,
    // mirroring subsidiaryVisibleFilter's orgWideNull reads.
    if (
      spec.allowedSubsidiaryIds !== null &&
      row.subsidiary_id !== null &&
      !spec.allowedSubsidiaryIds.has(row.subsidiary_id)
    ) {
      return `${spec.field} "${id}" is outside your subsidiaries`;
    }
    if (spec.expectAccountType !== undefined && row.type !== spec.expectAccountType) {
      const label = spec.expectAccountType === BANK_ACCOUNT_TYPE ? "a bank account" : "a card account";
      return `${spec.field} "${id}" must be ${label} (${spec.expectAccountType}), got "${row.type}"`;
    }
    if (spec.expectPostable === true && row.is_summary) {
      return `${spec.field} "${id}" must be a postable account, not a summary account`;
    }
  }
  return null;
}

async function checkParties(orgId: string, spec: ReferenceSpec): Promise<string | null> {
  for (const id of spec.ids) {
    if (!UUID_RE.test(id)) return `${spec.field} "${id}" is not a valid UUID`;
  }
  if (!spec.ids.length) return null;
  // parties.kind is only the PRIMARY kind: a customer-kind party can still
  // hold a vendor role, so role membership (not kind) decides. Same join as
  // the compliance loader: vendor_roles on (org_id, party_id).
  const rows = await db.execute<PartyRow>(sql`
    select p.id::text as id,
           exists(select 1 from vendor_roles vr where vr.org_id = p.org_id and vr.party_id = p.id) as is_vendor,
           p.subsidiary_id::text as subsidiary_id
      from parties p
     where p.org_id = ${orgId} and p.id = any(${`{${spec.ids.join(",")}}`}::uuid[])
  `);
  const found = new Map(rows.rows.map((row) => [row.id.toLowerCase(), row]));
  for (const id of spec.ids) {
    const row = found.get(id.toLowerCase());
    if (!row) return `${spec.field} "${id}" is not ${spec.kind} in this organization`;
    if (
      spec.allowedSubsidiaryIds !== null &&
      row.subsidiary_id !== null &&
      !spec.allowedSubsidiaryIds.has(row.subsidiary_id)
    ) {
      return `${spec.field} "${id}" is outside your subsidiaries`;
    }
    if (spec.expectVendorRole === true && !row.is_vendor) {
      return `${spec.field} "${id}" is not a vendor in this organization`;
    }
  }
  return null;
}

/**
 * Validate reference lists for type, existence, and scope: every id must be
 * a UUID (anything else would explode the cast into a 500) resolving to a
 * row in this org, of the expected type/kind, inside the caller's
 * subsidiaries. Returns the first refusal, or null when everything resolves.
 * A misspelled or foreign id refuses here by name; saved, it would forecast
 * silent zero.
 */
export async function validateReferences(orgId: string, specs: ReferenceSpec[]): Promise<string | null> {
  for (const spec of specs) {
    const error =
      spec.table === "accounts" ? await checkAccounts(orgId, spec) : await checkParties(orgId, spec);
    if (error) return error;
  }
  return null;
}
