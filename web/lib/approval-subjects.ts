import "server-only";

import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/platform/db";
import {
  financialChangeEventLabel,
  loadFinancialChangeSubjectLabel,
  type FinancialChangeDomain,
} from "@openbooks/engine/platform/financial-changes";
import { pgTextArrayLiteral } from "./pg-array";
import { isUuid } from "@openbooks/engine/platform/identifiers";

/**
 * Party + decision summary for subject-kind approval rows.
 *
 * Document gates carry their party and total on the joined document; every
 * other gatable kind renders an opaque id with nowhere to click unless a
 * resolver below names its subject. Resolvers are per kind, batched, and
 * org-scoped — never inline special cases in the inbox view, and never a
 * cross-org read: an unresolvable subject keeps nulls and the row falls
 * back to the id, exactly like a restricted caller failing closed.
 */

export interface ApprovalSubjectDetail {
  /** Who the decision is about (the employee for change requests). */
  partyName: string | null;
  /** What the approver decides (change kind, effective date, and
   *  compensation terms where the payload carries them). */
  summary: string | null;
  /** Kind-column label override (the accounting event for financial
   *  changes, which otherwise renders as the bare subject kind). */
  kindLabel?: string | null;
  /** Proposed money the change carries, as a decimal string. */
  amount?: string | null;
  /** Currency of `amount` (org base applies when absent). */
  currency?: string | null;
  /**
   * Share quantity the subject carries, as a decimal string: rendered as a
   * count of shares, never as money.
   */
  quantity?: string | null;
  /** The quantity is a signed change (a reserve increase or reduction). */
  quantitySigned?: boolean;
  /**
   * The command endpoint that withdraws the subject while it awaits a
   * decision, for kinds whose requester may withdraw it (the endpoint
   * itself verifies the requester and the pending state).
   */
  withdrawEndpoint?: string | null;
}

export interface ApprovalSubjectText {
  (key: string): string;
  has: (key: string) => boolean;
}

type SubjectResolver = (
  orgId: string,
  subjectIds: string[],
  text: ApprovalSubjectText,
) => Promise<Map<string, ApprovalSubjectDetail>>;

/** Change kinds with requestKinds catalog labels (me.requestKinds.*). */
const KNOWN_CHANGE_KINDS = [
  "hire",
  "status_change",
  "assignment_change",
  "termination",
  "position_assignment",
  "profile_change",
] as const;

function changeKindLabel(text: ApprovalSubjectText, kind: string): string {
  const key = `me.requestKinds.${kind}`;
  return (KNOWN_CHANGE_KINDS as readonly string[]).includes(kind) && text.has(key)
    ? text(key)
    : kind;
}

/**
 * Compensation terms from the proposal payload. No v1 payload kind (hire,
 * status_change, assignment_change, termination, position_assignment,
 * profile_change) carries compensation — terms live on the employment's
 * wage rates, never the proposal — so none render today. This stays the
 * single place a future payload version plugs its terms into, rather
 * than a second formatter beside the row.
 */
function compensationTerms(payload: Record<string, unknown>): string | null {
  const terms = payload.compensation;
  if (typeof terms === "string" && terms.trim()) return terms.trim();
  return null;
}

function changeRequestSummary(
  payload: Record<string, unknown>,
  text: ApprovalSubjectText,
): string | null {
  const kind = typeof payload.kind === "string" ? payload.kind : null;
  const effective =
    typeof payload.effectiveFrom === "string"
      ? payload.effectiveFrom
      : typeof payload.effectiveDate === "string"
        ? payload.effectiveDate
        : null;
  const parts = [
    kind ? changeKindLabel(text, kind) : null,
    effective ? `${text("queue.columns.effective")} ${effective}` : null,
    compensationTerms(payload),
  ].filter((part): part is string => part != null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function resolveHrmChangeRequests(
  orgId: string,
  subjectIds: string[],
  text: ApprovalSubjectText,
): Promise<Map<string, ApprovalSubjectDetail>> {
  const out = new Map<string, ApprovalSubjectDetail>();
  const ids = [...new Set(subjectIds)].filter((id) => isUuid(id));
  if (ids.length === 0) return out;
  const rows = await db.execute<{
    id: string;
    employeeName: string | null;
    payload: Record<string, unknown>;
  }>(
    sql`
    select r.id, p.display_name as "employeeName", r.payload
      from hrm_employment_change_requests r
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
      join parties p on p.id = e.worker_party_id and p.org_id = r.org_id
     where r.org_id = ${orgId} and r.id = any(${pgTextArrayLiteral(ids)}::uuid[])
  `,
    "objects",
  );
  for (const row of rows) {
    out.set(String(row.id), {
      partyName: row.employeeName,
      summary: changeRequestSummary((row.payload ?? {}) as Record<string, unknown>, text),
    });
  }
  return out;
}

/**
 * Top-level payload keys that carry proposed money, in priority order. The
 * proposal is the record of what the approver releases, so only the frozen
 * payload counts — never a regenerated measurement beside it.
 */
const FINANCIAL_CHANGE_AMOUNT_KEYS = [
  "amount",
  "estimate",
  "totalAmount",
  "newTotal",
  "settlement",
  "payment",
] as const;

function financialChangeAmount(payload: Record<string, unknown>): string | null {
  for (const key of FINANCIAL_CHANGE_AMOUNT_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function financialChangeCurrency(payload: Record<string, unknown>): string | null {
  const currency = payload.currency;
  return typeof currency === "string" && currency.trim() !== "" ? currency.trim() : null;
}

async function resolveFinancialChanges(
  orgId: string,
  subjectIds: string[],
): Promise<Map<string, ApprovalSubjectDetail>> {
  const out = new Map<string, ApprovalSubjectDetail>();
  const ids = [...new Set(subjectIds)].filter((id) => isUuid(id));
  if (ids.length === 0) return out;
  const rows = await db.execute<{
    id: string;
    domain: string;
    operation: string;
    subjectId: string;
    payload: Record<string, unknown>;
  }>(
    sql`
    select id::text as id, domain, operation, subject_id::text as "subjectId", payload
      from financial_changes
     where org_id = ${orgId} and id = any(${pgTextArrayLiteral(ids)}::uuid[])
  `,
    "objects",
  );
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const subjectLabel = await loadFinancialChangeSubjectLabel(
      db,
      orgId,
      row.domain as FinancialChangeDomain,
      row.subjectId,
      row.operation,
    );
    out.set(String(row.id), {
      // The payroll subject is the person the entitlement is for; every
      // other domain decides a record, not a party.
      partyName: row.domain === "payroll" ? subjectLabel : null,
      summary: subjectLabel ?? financialChangeEventLabel(row.operation),
      kindLabel: financialChangeEventLabel(row.operation),
      amount: financialChangeAmount(payload),
      currency: financialChangeCurrency(payload),
    });
  }
  return out;
}

/** An exact decimal string as recorded (optionally signed); anything else is not a figure. */
const EXACT_DECIMAL = /^[+-]?\d+(\.\d+)?$/;

function exactDecimal(value: string | null): string | null {
  const text = value?.trim() ?? "";
  return EXACT_DECIMAL.test(text) ? text : null;
}

/**
 * Governed equity actions, from the request as its requester recorded it:
 * the kind label names the action ("Equity action · Reserve change"), the
 * summary the record it concerns, the party the holder it affects, and the
 * figure what it carries. The request's frozen `summary` holds the figures a
 * Flow condition reads — `holderName` for security events and MFN elections,
 * `quantity` in shares (a signed delta for a plan reserve change, authorized
 * shares for a class amendment, the event quantity for security events),
 * `amount` with its `currency` for security events, MFN elections and round
 * amendments (pre-money valuation), a reversal's figures from the event it
 * undoes (what it restores), and a class amendment's conversion price,
 * which carries no currency of its own and so reads in the legal entity's
 * functional currency. Runs, policy versions and splits carry no figure.
 * A pending request names its withdrawal endpoint.
 */
async function resolveEquityActions(
  orgId: string,
  subjectIds: string[],
): Promise<Map<string, ApprovalSubjectDetail>> {
  const out = new Map<string, ApprovalSubjectDetail>();
  const ids = [...new Set(subjectIds)].filter((id) => isUuid(id));
  if (ids.length === 0) return out;
  const [t, ta] = await Promise.all([getTranslations("equity"), getTranslations("approvals")]);
  const rows = await db.execute<{
    id: string;
    action: string;
    subjectLabel: string;
    status: string;
    holderName: string | null;
    quantity: string | null;
    amount: string | null;
    currency: string | null;
  }>(
    sql`
    select r.id::text as id, r.action, r.subject_label as "subjectLabel", r.status,
           nullif(btrim(r.summary->>'holderName'), '') as "holderName",
           coalesce(r.summary->>'quantity', reversed.quantity::text) as quantity, coalesce(r.summary->>'amount', reversed.amount::text) as amount,
           coalesce(nullif(btrim(r.summary->>'currency'), ''), nullif(btrim(s.base_currency), '')) as currency
      from equity_action_requests r
      left join subsidiaries s on s.id = r.subsidiary_id and s.org_id = r.org_id
      left join equity_security_events reversed
        on r.action = 'reverse' and reversed.org_id = r.org_id and reversed.security_id = r.subject_id
       and reversed.id::text = r.payload->>'reversesEventId'
     where r.org_id = ${orgId} and r.id = any(${pgTextArrayLiteral(ids)}::uuid[])
  `,
    "objects",
  );
  for (const row of rows) {
    const action = t.has(`approval.action.${row.action}`)
      ? t(`approval.action.${row.action}` as never)
      : row.action;
    const amount = exactDecimal(row.amount);
    out.set(String(row.id), {
      partyName: row.holderName,
      summary: row.subjectLabel,
      kindLabel: `${ta("kinds.equity_action")} · ${action}`,
      quantity: exactDecimal(row.quantity),
      quantitySigned: row.action === "reserve_change",
      // Money without a resolvable currency is not shown as money.
      amount: amount && row.currency ? amount : null,
      currency: amount ? row.currency : null,
      withdrawEndpoint:
        row.status === "pending_approval" ? `/api/equity/requests/${row.id}/withdraw` : null,
    });
  }
  return out;
}

const SUBJECT_RESOLVERS: Record<string, SubjectResolver> = {
  hrm_employment_change_request: resolveHrmChangeRequests,
  financial_change: (orgId, subjectIds) => resolveFinancialChanges(orgId, subjectIds),
  equity_action: (orgId, subjectIds) => resolveEquityActions(orgId, subjectIds),
};

/**
 * Batched subject details for approval rows, keyed `${kind}:${subjectId}`.
 * Kinds without a resolver resolve to nothing — the row keeps its id
 * fallback — and unresolvable subjects stay absent rather than throwing.
 */
export async function resolveApprovalSubjects(
  orgId: string,
  items: ReadonlyArray<{ kind: string; subjectId: string }>,
  text: ApprovalSubjectText,
): Promise<Map<string, ApprovalSubjectDetail>> {
  const out = new Map<string, ApprovalSubjectDetail>();
  const byKind = new Map<string, string[]>();
  for (const item of items) {
    if (!SUBJECT_RESOLVERS[item.kind]) continue;
    const ids = byKind.get(item.kind) ?? [];
    ids.push(item.subjectId);
    byKind.set(item.kind, ids);
  }
  for (const [kind, ids] of byKind) {
    const resolved = await SUBJECT_RESOLVERS[kind]!(orgId, ids, text);
    for (const [id, detail] of resolved) out.set(`${kind}:${id}`, detail);
  }
  return out;
}
