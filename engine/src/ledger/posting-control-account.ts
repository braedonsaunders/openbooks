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
 *   3. the organization control account (Setup → Company & Accounting → Control accounts).
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
  return `set an active ${NOUN[side]} control account in Setup → Company & Accounting → Control accounts`;
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

/**
 * The control account a posted party document's open item actually carries:
 * its stamped choice when present, else the account of its posted open-item
 * leg (documents posted before the stamp existed). Null for documents with
 * no posted open item. A follow-on document that must settle against this
 * one (a credit memo for an invoice) inherits this account.
 */
export async function postedDocumentControlAccount(
  runner: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
): Promise<string | null> {
  const row = (await runner.execute<{ account_id: string | null }>(sql`
    select coalesce(
             (select jl.account_id::text
                from journal_lines jl
               where jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
               order by jl.line_number
               limit 1),
             nullif(d.custom->>'controlAccountId', '')) as account_id
      from documents d
     where d.org_id = ${orgId} and d.id = ${documentId} and d.status = 'posted'`)).rows[0];
  return row?.account_id ?? null;
}

/**
 * Identity facts a caller needs to scope a control-account lookup: the
 * party's subsidiary and the document's status and subsidiary, each null
 * when the id names nothing of that kind in this organization.
 */
export async function controlAccountLookupScope(
  runner: Pick<typeof db, "execute">,
  input: { orgId: string; kind: string; partyId: string | null; documentId: string | null },
): Promise<{
  party: { subsidiaryId: string | null } | null;
  document: { status: string; subsidiaryId: string | null } | null;
}> {
  const party = input.partyId
    ? (await runner.execute<{ subsidiaryId: string | null }>(sql`
        select subsidiary_id as "subsidiaryId" from parties
         where id = ${input.partyId} and org_id = ${input.orgId}`)).rows[0] ?? null
    : null;
  const document = input.documentId
    ? (await runner.execute<{ status: string; subsidiaryId: string | null }>(sql`
        select status, subsidiary_id as "subsidiaryId" from documents
         where id = ${input.documentId} and org_id = ${input.orgId} and kind = ${input.kind}`)).rows[0] ?? null
    : null;
  return { party, document };
}

export interface ControlAccountOption {
  id: string;
  number: string | null;
  name: string;
}

export interface ControlAccountChoices {
  side: ControlSide;
  /** Active posting accounts of the side's type visible to the subsidiary. */
  accounts: ControlAccountOption[];
  /** The party's default, when it has one. */
  partyDefault: ControlAccountOption | null;
  /** The organization control account, when configured. */
  organizationDefault: ControlAccountOption | null;
  /** The document's current choice, labelled even if no longer offered. */
  selected: ControlAccountOption | null;
  /** For a posted document: the account its open item actually carries. */
  posted: ControlAccountOption | null;
}

/**
 * What a party document's receivable/payable picker offers and what an
 * empty choice resolves to. Read-only; the edit boundary and the posting
 * kernel re-validate whatever is chosen.
 */
export async function controlAccountChoices(
  runner: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    kind: string;
    partyId: string | null;
    subsidiaryId: string | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    /** The form's current choice, to label. */
    selectedAccountId?: string | null;
    /** A posted document of this organization whose carried account to report. */
    postedDocumentId?: string | null;
  },
): Promise<ControlAccountChoices | null> {
  const side = DOCUMENT_CONTROL_SIDE[input.kind];
  if (!side) return null;
  const allowed = input.allowedSubsidiaryIds === null ? null : [...input.allowedSubsidiaryIds];
  const accounts = (await runner.execute<ControlAccountOption>(sql`
    select a.id, a.number, a.name
      from accounts a
     where a.org_id = ${input.orgId} and a.is_active and not a.is_summary
       and a.type = ${EXPECTED_TYPE[side]}
       and (a.subsidiary_id is null or a.subsidiary_id = ${input.subsidiaryId}::uuid)
       and (${allowed === null}::boolean or a.subsidiary_id is null
            or a.subsidiary_id = any(${`{${(allowed ?? []).join(",")}}`}::uuid[]))
     order by a.number nulls last, a.name`)).rows;
  const label = async (id: string | null): Promise<ControlAccountOption | null> => {
    if (!id || !isUuid(id)) return null;
    const row = (await runner.execute<ControlAccountOption>(sql`
      select id, number, name from accounts where org_id = ${input.orgId} and id = ${id}::uuid`)).rows[0];
    return row ?? null;
  };
  const role = input.partyId
    ? (await runner.execute<{ account_id: string | null }>(
        side === "ar"
          ? sql`select ar_account_id::text as account_id from customer_roles
                 where org_id = ${input.orgId} and party_id = ${input.partyId}`
          : sql`select ap_account_id::text as account_id from vendor_roles
                 where org_id = ${input.orgId} and party_id = ${input.partyId}`,
      )).rows[0]?.account_id ?? null
    : null;
  const org = (await runner.execute<{ account_id: string | null }>(sql`
    select settings->'controlAccounts'->>${side}::text as account_id
      from orgs where id = ${input.orgId}`)).rows[0]?.account_id ?? null;
  const postedAccount = input.postedDocumentId
    ? await postedDocumentControlAccount(runner, input.orgId, input.postedDocumentId)
    : null;
  return {
    side,
    accounts,
    partyDefault: await label(role),
    organizationDefault: await label(org),
    selected: await label(input.selectedAccountId ?? null),
    posted: await label(postedAccount),
  };
}
