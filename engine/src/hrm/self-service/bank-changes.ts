import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { sealSecret } from "../../platform/secrets.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { requireHrmSelfRead, requireHrmSelfRequest } from "../authorization.ts";
import {
  createChangeRequestDraft,
  submitChangeRequest,
  type ChangeRequestDTO,
} from "../change-requests.ts";
import { actorPartyOf, ownEmploymentOrHireRemedy, SelfServiceError } from "./actor.ts";
import { escapeHtml } from "../recruiting/depth.ts";
import {
  bankChangeProposalSchema,
  type BankChangeProposal,
} from "./bank-schema.ts";
import { inputGuards } from "../input-guards.ts";

/**
 * Self-service direct-deposit changes.
 *
 * A person proposes new bank details for THEMSELVES as a bank_change
 * request through the existing change-request service: same draft
 * lifecycle, same native Flows approval by HR, same decision snapshot —
 * approval applies the sealed details onto a new approved
 * party_bank_accounts row in the same transaction (see applyBankChange
 * in engine/src/hrm/change-requests.ts). Approval is optional: with no
 * enabled flow the submission applies directly through the governed
 * admission, exactly like every other change kind.
 *
 * Plaintext discipline: the proposal validates, seals in memory, and
 * files only the sealed shape. The full number never lands in a table
 * (payload included), a log, or an email — storage, audit, and
 * notifications carry the sealed text and the last four at most.
 *
 * Fraud notice: when this call applies the change (the no-flow direct
 * path), the worker's existing email gets an out-of-band notice naming
 * the bank and the last four — never the number. The notice stages from
 * committed state and enqueues after commit (the staged-then-enqueued
 * offer pattern), with a deterministic job id so a retry cannot double
 * send. Gated approvals rely on the HR review itself as the control;
 * extending the notice there needs a post-commit hook in the decide
 * path, which the flows module owns.
 */

const { requireOrgId, requireActorId, requireId } = inputGuards((message) => new SelfServiceError("REFUSED", message));

function requireBankReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 500) {
    throw new SelfServiceError(
      "REFUSED",
      "a bank change needs a reason between 5 and 500 characters — the reason retires the prior details as evidence",
    );
  }
  return reason.trim();
}

/**
 * Validate a raw bank proposal. Pure: unit-tested without a database.
 * Every zod failure names its field; the plaintext it validates never
 * persists — the caller seals it before filing.
 */
export function validateBankChange(raw: unknown): BankChangeProposal {
  const parsed = bankChangeProposalSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message,
      )
      .join("; ");
    throw new SelfServiceError("REFUSED", `bank change refused: ${fields}`);
  }
  return parsed.data;
}

export interface FileBankDetailsChangeQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly bank: unknown;
  readonly reason: unknown;
  /** Test/queue seam: defaults to the real job enqueue after commit. */
  readonly notifyBankChange?: BankChangeNotifier;
}

export interface FileBankDetailsChangeResult {
  readonly request: ChangeRequestDTO;
  readonly applied: boolean;
  /** True once the fraud notice is enqueued (direct-apply path only). */
  readonly notified: boolean;
}

export interface BankChangeNotice {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export type BankChangeNotifier = (
  data: { orgId: string; to: string; subject: string; html: string; text: string },
  options: { jobId: string },
) => Promise<unknown>;

async function defaultNotifyBankChange(
  data: { orgId: string; to: string; subject: string; html: string; text: string },
  options: { jobId: string },
): Promise<unknown> {
  const { enqueueEmail } = await import("@openbooks/jobs");
  return enqueueEmail(data, options);
}

function stageBankChangeNotice(args: {
  orgId: string;
  to: string;
  workerName: string;
  bankName: string;
  lastFour: string;
  changeId: string;
}): { notice: BankChangeNotice; jobId: string } {
  const subject = "Your direct-deposit details changed";
  const text =
    `Dear ${args.workerName}, the direct-deposit bank details on your employment were changed ` +
    `to ${args.bankName} ending ${args.lastFour}. If this was not you, contact HR immediately.`;
  const html =
    `<p>Dear ${escapeHtml(args.workerName)},</p>` +
    `<p>The direct-deposit bank details on your employment were changed to ` +
    `${escapeHtml(args.bankName)} ending ${escapeHtml(args.lastFour)}.</p>` +
    `<p>If this was not you, contact HR immediately.</p>`;
  return {
    notice: { to: args.to, subject, html, text },
    jobId: `bank-details-changed|${args.orgId}|${args.changeId}`,
  };
}

async function workerContact(
  exec: SqlExecutor,
  args: { orgId: string; employmentId: string },
): Promise<{ name: string; email: string | null }> {
  const row = (await exec.execute<{ name: string; email: string | null }>(sql`
    select p.display_name as name, p.email as email
      from parties p
      join worker_employments e on e.org_id = p.org_id and e.worker_party_id = p.id
     where e.org_id = ${args.orgId} and e.id = ${args.employmentId}
  `)).rows[0];
  return { name: row?.name ?? "employee", email: row?.email ?? null };
}

export async function fileBankDetailsChange(
  query: FileBankDetailsChangeQuery,
): Promise<FileBankDetailsChangeResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  const bank = validateBankChange(query.bank);
  const reason = requireBankReason(query.reason);
  const notify = query.notifyBankChange ?? defaultNotifyBankChange;
  // Seal in memory before anything persists: the draft stores the sealed
  // text under the native bank purpose (the payroll decrypt path), so
  // this row pays exactly like a natively filed one. Last-four echo
  // follows the native rule (trailing four of the trimmed number).
  const accountNumber = bank.accountNumber.trim();
  const sealedAccount = sealSecret(accountNumber, { orgId, purpose: "payment.counterparty.account" });
  const accountLastFour = accountNumber.slice(-4);
  const result = await withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, "hrm"))) {
      throw new SelfServiceError(
        "FORBIDDEN",
        "hrm feature is disabled: enable it on Company Settings → Features before using self-service",
      );
    }
    await requireHrmSelfRequest(db, orgId, actorId);
    await actorPartyOf(db, orgId, actorId);
    // Fail fast with the self-service remedy before any draft exists.
    await ownEmploymentOrHireRemedy(db, { orgId, actorId, employmentId });
    const request = await createChangeRequestDraft({
      orgId,
      actorId,
      employmentId,
      payload: {
        kind: "bank_change",
        bankName: bank.bankName.trim(),
        ...(bank.country === undefined ? {} : { country: bank.country }),
        ...(bank.currency === undefined ? {} : { currency: bank.currency }),
        ...(bank.routing === undefined ? {} : { routing: bank.routing }),
        sealedAccount,
        accountLastFour,
      },
    });
    const submitted = await submitChangeRequest({ orgId, actorId, requestId: request.id, reason });
    return { request: submitted, applied: submitted.status === "applied" };
  });
  if (!result.applied || !result.request.appliedEmploymentChangeId) {
    // Gated: nothing changed yet — the HR review is the control, and the
    // notice waits for the change itself.
    return { request: result.request, applied: false, notified: false };
  }
  // Post-commit by construction (the transaction above returned): stage
  // from committed state — the worker's existing email, masked details
  // only — then enqueue. A refused enqueue must not rewrite history, so
  // it reports notified:false instead of throwing.
  const contact = await withOrgTransaction(orgId, async () =>
    workerContact(db, { orgId, employmentId }),
  );
  if (!contact.email || contact.email.trim().length === 0) {
    return { request: result.request, applied: true, notified: false };
  }
  const staged = stageBankChangeNotice({
    orgId,
    to: contact.email.trim(),
    workerName: contact.name,
    bankName: bank.bankName.trim(),
    lastFour: accountLastFour,
    changeId: result.request.appliedEmploymentChangeId,
  });
  try {
    await notify(
      { orgId, to: staged.notice.to, subject: staged.notice.subject, html: staged.notice.html, text: staged.notice.text },
      { jobId: staged.jobId },
    );
    return { request: result.request, applied: true, notified: true };
  } catch {
    return { request: result.request, applied: true, notified: false };
  }
}

/**
 * The worker's own bank details, masked for self-service display. Sealed
 * numbers are never selected — the last four is the only account
 * evidence that leaves storage. Active rows first, then pending ones
 * awaiting HR; retired history stays out.
 */
export interface OwnBankAccountDTO {
  readonly id: string;
  readonly bankName: string | null;
  readonly country: string | null;
  readonly currency: string | null;
  readonly lastFour: string | null;
  readonly approvalStatus: string;
  readonly isActive: boolean;
}

export async function listOwnBankAccounts(query: {
  orgId: string;
  actorId: string;
}): Promise<readonly OwnBankAccountDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireHrmSelfRead(db, orgId, actorId);
    const partyId = await actorPartyOf(db, orgId, actorId);
    const rows = (await db.execute<{
      id: string;
      bankName: string | null;
      country: string | null;
      currency: string | null;
      lastFour: string | null;
      approvalStatus: string;
      isActive: boolean;
    }>(sql`
      select id::text as id, bank_name as "bankName", country, currency,
             account_last_four as "lastFour", approval_status as "approvalStatus",
             is_active as "isActive"
        from party_bank_accounts
       where org_id = ${orgId} and party_id = ${partyId} and retired_at is null
       order by is_active desc, created_at desc, id
       limit 25
    `)).rows;
    return rows.map((row) => ({
      id: row.id,
      bankName: row.bankName,
      country: row.country,
      currency: row.currency,
      lastFour: row.lastFour,
      approvalStatus: row.approvalStatus,
      isActive: row.isActive,
    }));
  });
}
