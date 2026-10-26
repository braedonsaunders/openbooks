import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "./org-feature-lock.ts";
import { uuidArray } from "./subsidiaries.ts";

/**
 * Intercompany account policy shared by posting, netting and fulfillment.
 *
 * An intercompany pair names, for each of its two subsidiaries, the account
 * that carries that entity's due-to/due-from position with the other, and
 * optionally the receivable and payable control accounts its intercompany
 * invoices and bills post to. A representing party is the customer or vendor
 * that stands for a subsidiary; a document with one is intercompany and its
 * open item posts to the pair's intercompany control account for the
 * document's own entity, so consolidation eliminates it with the pair.
 */

export class IntercompanyPolicyError extends Error {
  override readonly name = "IntercompanyPolicyError";
}

export type IntercompanyPairRow = {
  id: string;
  fromSubsidiaryId: string;
  toSubsidiaryId: string;
  dueFromAccountId: string;
  dueToAccountId: string;
  fromReceivableAccountId: string | null;
  fromPayableAccountId: string | null;
  toReceivableAccountId: string | null;
  toPayableAccountId: string | null;
  isActive: boolean;
};

/** The accounts one side of a pair uses with its counterparty. */
export interface IntercompanySideAccounts {
  pairId: string;
  subsidiaryId: string;
  counterpartySubsidiaryId: string;
  /** Due-to/due-from position account of this side. */
  positionAccountId: string;
  receivableAccountId: string | null;
  payableAccountId: string | null;
}

/** Pure: the accounts `subsidiaryId` uses on `pair`; null when it is not a side. */
export function intercompanySideAccounts(
  pair: IntercompanyPairRow,
  subsidiaryId: string,
): IntercompanySideAccounts | null {
  if (pair.fromSubsidiaryId === subsidiaryId) {
    return {
      pairId: pair.id,
      subsidiaryId,
      counterpartySubsidiaryId: pair.toSubsidiaryId,
      positionAccountId: pair.dueFromAccountId,
      receivableAccountId: pair.fromReceivableAccountId,
      payableAccountId: pair.fromPayableAccountId,
    };
  }
  if (pair.toSubsidiaryId === subsidiaryId) {
    return {
      pairId: pair.id,
      subsidiaryId,
      counterpartySubsidiaryId: pair.fromSubsidiaryId,
      positionAccountId: pair.dueToAccountId,
      receivableAccountId: pair.toReceivableAccountId,
      payableAccountId: pair.toPayableAccountId,
    };
  }
  return null;
}

const PAIR_COLUMNS = sql`
  id, from_subsidiary_id as "fromSubsidiaryId", to_subsidiary_id as "toSubsidiaryId",
  due_from_account_id as "dueFromAccountId", due_to_account_id as "dueToAccountId",
  from_receivable_account_id as "fromReceivableAccountId", from_payable_account_id as "fromPayableAccountId",
  to_receivable_account_id as "toReceivableAccountId", to_payable_account_id as "toPayableAccountId",
  is_active as "isActive"`;

/** The org's pair between two subsidiaries (either orientation), or null. */
export async function loadIntercompanyPair(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryA: string,
  subsidiaryB: string,
): Promise<IntercompanyPairRow | null> {
  const row = (
    await runner.execute<IntercompanyPairRow>(
      sql`
    select ${PAIR_COLUMNS}
      from intercompany_pairs
     where org_id = ${orgId}
       and ((from_subsidiary_id = ${subsidiaryA} and to_subsidiary_id = ${subsidiaryB})
         or (from_subsidiary_id = ${subsidiaryB} and to_subsidiary_id = ${subsidiaryA}))
     limit 1`,
      "objects",
    )
  )[0];
  return row ?? null;
}

/** Every active pair of the org, in a stable order. */
export async function loadActiveIntercompanyPairs(
  runner: SqlExecutor,
  orgId: string,
): Promise<IntercompanyPairRow[]> {
  return await runner.execute<IntercompanyPairRow>(
    sql`
    select ${PAIR_COLUMNS}
      from intercompany_pairs
     where org_id = ${orgId} and is_active
     order by created_at, id`,
    "objects",
  );
}

export interface IntercompanyRepresentation {
  representationId: string;
  /** The subsidiary the party represents. */
  subsidiaryId: string;
  subsidiaryName: string;
  role: "customer" | "vendor";
}

/** The active representation a party holds in one role, or null. */
export async function loadPartyRepresentation(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  role: "customer" | "vendor",
): Promise<IntercompanyRepresentation | null> {
  const row = (
    await runner.execute<{ id: string; subsidiaryId: string; subsidiaryName: string }>(
      role === "customer"
        ? sql`select r.id, r.subsidiary_id as "subsidiaryId", s.name as "subsidiaryName"
              from intercompany_representing_parties r
              join subsidiaries s on s.org_id = r.org_id and s.id = r.subsidiary_id
             where r.org_id = ${orgId} and r.customer_party_id = ${partyId} and r.is_active`
        : sql`select r.id, r.subsidiary_id as "subsidiaryId", s.name as "subsidiaryName"
              from intercompany_representing_parties r
              join subsidiaries s on s.org_id = r.org_id and s.id = r.subsidiary_id
             where r.org_id = ${orgId} and r.vendor_party_id = ${partyId} and r.is_active`,
      "objects",
    )
  )[0];
  return row
    ? {
        representationId: row.id,
        subsidiaryId: row.subsidiaryId,
        subsidiaryName: row.subsidiaryName,
        role,
      }
    : null;
}

/** The active representing customer and vendor of one subsidiary. */
export async function loadSubsidiaryRepresentatives(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<{ customerPartyId: string | null; vendorPartyId: string | null } | null> {
  const row = (
    await runner.execute<{ customerPartyId: string | null; vendorPartyId: string | null }>(
      sql`
    select customer_party_id as "customerPartyId", vendor_party_id as "vendorPartyId"
      from intercompany_representing_parties
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and is_active`,
      "objects",
    )
  )[0];
  return row ?? null;
}

export const INTERCOMPANY_TRANSACTIONS_FEATURE = "intercompanyTransactions";

const PAIR_REMEDY = "configure it under Setup → Accounting → Intercompany pairs";

export interface IntercompanyControlAccount {
  accountId: string;
  pairId: string;
  representedSubsidiaryId: string;
  representedSubsidiaryName: string;
}

/**
 * The intercompany control account an AR/AP document posts its open item to
 * when its party represents another subsidiary; null for an ordinary party.
 *
 * Refuses, naming the remedy, when the party represents the document's own
 * subsidiary (an entity cannot trade with itself), when Intercompany
 * transactions is off while the representation is active (posting through
 * ordinary receivables would hide the balance from elimination), when no
 * active pair joins the two entities, or when the pair has no intercompany
 * control account for the document's side. Runs inside the posting
 * transaction: the feature check holds the switchboard row to commit.
 */
export async function intercompanyControlAccount(
  runner: SqlExecutor,
  input: {
    orgId: string;
    side: "ar" | "ap";
    partyId: string;
    /** The document's subsidiary; null is the root subsidiary. */
    subsidiaryId: string | null;
  },
): Promise<IntercompanyControlAccount | null> {
  const role = input.side === "ar" ? "customer" : "vendor";
  const representation = await loadPartyRepresentation(runner, input.orgId, input.partyId, role);
  if (!representation) return null;
  const partyLabel = input.side === "ar" ? "customer" : "vendor";
  if (!(await lockAndCheckOrgFeature(runner, input.orgId, INTERCOMPANY_TRANSACTIONS_FEATURE))) {
    throw new IntercompanyPolicyError(
      `this ${partyLabel} represents ${representation.subsidiaryName}; turn on Intercompany transactions in Company Settings → Features, or end the representation in Setup → Accounting → Intercompany representing parties`,
    );
  }
  const documentSubsidiaryId = input.subsidiaryId ?? (await rootSubsidiaryId(runner, input.orgId));
  if (documentSubsidiaryId === representation.subsidiaryId) {
    throw new IntercompanyPolicyError(
      `this ${partyLabel} represents ${representation.subsidiaryName} itself; a subsidiary cannot be its own ${partyLabel} — post the document in another subsidiary or choose a different ${partyLabel}`,
    );
  }
  const pair = await loadIntercompanyPair(
    runner,
    input.orgId,
    documentSubsidiaryId,
    representation.subsidiaryId,
  );
  const names = await subsidiaryNames(runner, input.orgId, [documentSubsidiaryId]);
  const ownName = names.get(documentSubsidiaryId) ?? "this subsidiary";
  if (!pair || !pair.isActive) {
    throw new IntercompanyPolicyError(
      `no active intercompany pair joins ${ownName} and ${representation.subsidiaryName} — ${PAIR_REMEDY}`,
    );
  }
  const sideAccounts = intercompanySideAccounts(pair, documentSubsidiaryId)!;
  const accountId =
    input.side === "ar" ? sideAccounts.receivableAccountId : sideAccounts.payableAccountId;
  if (!accountId) {
    throw new IntercompanyPolicyError(
      `the intercompany pair of ${ownName} and ${representation.subsidiaryName} has no intercompany ${input.side === "ar" ? "receivable" : "payable"} account for ${ownName} — set it under Setup → Accounting → Intercompany pairs`,
    );
  }
  const account = (
    await runner.execute<{ eliminate: boolean; is_active: boolean }>(
      sql`
    select eliminate, is_active from accounts where org_id = ${input.orgId} and id = ${accountId}`,
      "objects",
    )
  )[0];
  if (!account || !account.is_active || !account.eliminate) {
    throw new IntercompanyPolicyError(
      `the intercompany ${input.side === "ar" ? "receivable" : "payable"} account for ${ownName} must be active and marked Eliminate on consolidation — correct it in Chart of accounts or on the intercompany pair`,
    );
  }
  return {
    accountId,
    pairId: pair.id,
    representedSubsidiaryId: representation.subsidiaryId,
    representedSubsidiaryName: representation.subsidiaryName,
  };
}

export async function rootSubsidiaryId(runner: SqlExecutor, orgId: string): Promise<string> {
  const row = (
    await runner.execute<{ id: string }>(
      sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`,
      "objects",
    )
  )[0];
  if (!row) throw new IntercompanyPolicyError("the organization has no root subsidiary");
  return row.id;
}

export async function subsidiaryNames(
  runner: SqlExecutor,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await runner.execute<{ id: string; name: string }>(
    sql`
    select id, name from subsidiaries
     where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])`,
    "objects",
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}
