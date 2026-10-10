import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { loadSubsidiaryContext, restrictionAdmits } from "../organization/subsidiaries.ts";

/**
 * Receivable/payable control account resolution for party documents.
 *
 * A sales or purchase document posts its open item to exactly one control
 * account, chosen in this order:
 *   1. the document's own choice (`custom.controlAccountId`),
 *   2. the party's default (customer_roles.ar_account_id /
 *      vendor_roles.ap_account_id),
 *   3. the organization control account (Setup → Company → Control accounts).
 *
 * The resolved account is stamped on the document when it posts, so the
 * document carries its own control account for its whole life: payments,
 * credit applications, write-offs, aging, statements and revaluation follow
 * the open item's own account, and a later change to the party or
 * organization default never reinterprets posted history.
 */
export type ControlSide = "ar" | "ap";

export const DOCUMENT_CONTROL_SIDE: Readonly<Record<string, ControlSide>> = {
  customer_invoice: "ar",
  customer_credit: "ar",
  vendor_bill: "ap",
  vendor_credit: "ap",
};

export type ControlAccountSource = "document" | "party" | "organization";

export interface ResolvedControlAccount {
  side: ControlSide;
  accountId: string;
  source: ControlAccountSource;
  number: string | null;
  name: string;
}

const EXPECTED_TYPE: Record<ControlSide, string> = {
  ar: "asset_receivable",
  ap: "liability_payable",
};

const NOUN: Record<ControlSide, string> = { ar: "receivable", ap: "payable" };

function remedyFor(side: ControlSide, source: ControlAccountSource): string {
  if (source === "document") {
    return `choose an active ${NOUN[side]} account on the document`;
  }
  if (source === "party") {
    return side === "ar"
      ? "correct the customer's Receivable account on the customer record, or choose a receivable account on the document"
      : "correct the vendor's Payable account on the vendor record, or choose a payable account on the document";
  }
  return `set an active ${NOUN[side]} control account in Setup → Company → Control accounts`;
}

function sourceLabel(side: ControlSide, source: ControlAccountSource): string {
  if (source === "document") return `the document's ${NOUN[side]} account`;
  if (source === "party") return side === "ar" ? "the customer's Receivable account" : "the vendor's Payable account";
  return `the organization ${NOUN[side]} control account`;
}

export interface ControlAccountSubject {
  orgId: string;
  kind: string;
  partyId: string | null;
  subsidiaryId: string | null;
  custom: unknown;
}

/** The document-level choice, when one is stored. */
export function documentControlChoice(custom: unknown): string | null {
  const value = (custom as Record<string, unknown> | null | undefined)?.controlAccountId;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Validate one candidate control account against the document it would
 * carry: same organization, active, posting (not summary), the side's
 * account type, and visible to the document's legal entity. Refuses with
 * the remedy for the source the candidate came from.
 */
export async function assertControlAccountUsable(
  runner: Pick<typeof db, "execute">,
  subject: Pick<ControlAccountSubject, "orgId" | "subsidiaryId">,
  side: ControlSide,
  candidate: string,
  source: ControlAccountSource,
): Promise<{ number: string | null; name: string }> {
  const label = sourceLabel(side, source);
  const remedy = remedyFor(side, source);
  if (!isUuid(candidate)) {
    throw new PostingError(`${label} is not a valid account reference — ${remedy}`);
  }
  const row = (await runner.execute<{
    number: string | null;
    name: string;
    type: string;
    is_active: boolean;
    is_summary: boolean;
    subsidiary_id: string | null;
    include_children: boolean;
  }>(sql`
    select a.number, a.name, a.type, a.is_active, a.is_summary, a.subsidiary_id,
           a.subsidiary_include_children as include_children
      from accounts a
     where a.org_id = ${subject.orgId} and a.id = ${candidate}::uuid`)).rows[0];
  if (!row) throw new PostingError(`${label} does not exist in this organization — ${remedy}`);
  const display = `${row.number ? `${row.number} · ` : ""}${row.name}`;
  if (!row.is_active) throw new PostingError(`${label} ${display} is inactive — ${remedy}`);
  if (row.is_summary) throw new PostingError(`${label} ${display} is a summary account — ${remedy}`);
  if (row.type !== EXPECTED_TYPE[side]) {
    throw new PostingError(
      `${label} ${display} is not a ${NOUN[side]} account (type ${row.type}; expected ${EXPECTED_TYPE[side]}) — ${remedy}`,
    );
  }
  if (row.subsidiary_id !== null && row.subsidiary_id !== subject.subsidiaryId) {
    // Same admission rule as every posted line: an account restricted to a
    // parent entity with children included admits the parent's subtree.
    const ctx = await loadSubsidiaryContext(runner, subject.orgId);
    const target = subject.subsidiaryId ?? ctx.rootId;
    if (!restrictionAdmits(ctx, row.subsidiary_id, row.include_children, target)) {
      throw new PostingError(
        `${label} ${display} belongs to a different subsidiary than the document — ${remedy}`,
      );
    }
  }
  return { number: row.number, name: row.name };
}

/**
 * Resolve (without validating) which candidate applies and where it came
 * from. Returns null when the document kind carries no party control
 * account, or when no candidate exists at any level.
 */
export async function controlAccountCandidate(
  runner: Pick<typeof db, "execute">,
  subject: ControlAccountSubject,
  orgControl?: { ar?: string | null; ap?: string | null },
): Promise<{ side: ControlSide; accountId: string | null; source: ControlAccountSource } | null> {
  const side = DOCUMENT_CONTROL_SIDE[subject.kind];
  if (!side) return null;
  const chosen = documentControlChoice(subject.custom);
  if (chosen) return { side, accountId: chosen, source: "document" };
  if (subject.partyId) {
    const role = (await runner.execute<{ account_id: string | null }>(
      side === "ar"
        ? sql`select ar_account_id::text as account_id from customer_roles
               where org_id = ${subject.orgId} and party_id = ${subject.partyId}`
        : sql`select ap_account_id::text as account_id from vendor_roles
               where org_id = ${subject.orgId} and party_id = ${subject.partyId}`,
    )).rows[0];
    if (role?.account_id) return { side, accountId: role.account_id, source: "party" };
  }
  const supplied = side === "ar" ? orgControl?.ar : orgControl?.ap;
  if (supplied) return { side, accountId: supplied, source: "organization" };
  const org = (await runner.execute<{ account_id: string | null }>(sql`
    select settings->'controlAccounts'->>${side}::text as account_id
      from orgs where id = ${subject.orgId}`)).rows[0];
  return { side, accountId: org?.account_id || null, source: "organization" };
}

/**
 * Resolve and validate the control account a party document posts to.
 * Returns null for kinds without a party control account. Refuses, with a
 * remedy, when nothing is configured or the resolved account is unusable.
 */
export async function resolveDocumentControlAccount(
  runner: Pick<typeof db, "execute">,
  subject: ControlAccountSubject,
  orgControl?: { ar?: string | null; ap?: string | null },
): Promise<ResolvedControlAccount | null> {
  const candidate = await controlAccountCandidate(runner, subject, orgControl);
  if (!candidate) return null;
  if (!candidate.accountId) {
    throw new PostingError(
      `no ${NOUN[candidate.side]} account is configured for this document — ${remedyFor(candidate.side, "organization")}`,
    );
  }
  const account = await assertControlAccountUsable(
    runner,
    subject,
    candidate.side,
    candidate.accountId,
    candidate.source,
  );
  return { side: candidate.side, accountId: candidate.accountId, source: candidate.source, ...account };
}
