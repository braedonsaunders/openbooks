import "server-only";
import type { Authz } from "@/lib/authz";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { apiErrorResponse } from "@/lib/api/error-response";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { encryptAccountNumber } from "@openbooks/engine/payments-core/rail-settings";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { routeSubjectSubmission } from "@openbooks/engine/flows/submission-policy";
import { BANK_ACCOUNT_SUBJECT_KIND } from "@openbooks/engine/flows/bank-accounts-adapter";
import {
  denyLockedOutsidePartyScope,
  denyOutsidePartyScope,
} from "@/app/api/parties/[id]/bank-accounts/party-scope";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid } from "@/lib/list-params";
import { normalizeCountryCode } from "@/lib/countries";
import { documentRevisionSql } from "@openbooks/engine/records/revision";
import { isDocumentRevisionToken } from "@/lib/api/registry-data";
import { notFound } from "@/lib/api/responses";

/**
 * Party bank details — the fraud-sensitive record behind the bank-details
 * approval flow.
 *
 * Every create starts PENDING (inactive, invisible to payment runs — see
 * payments.ts's `is_active AND approved_at IS NOT NULL` selection); a
 * material-field edit resets an approved row back to pending. Approval flows
 * on subject kind 'party_bank_account' route the gate; with no enabled flow
 * listening, the write applies the details directly (audited) instead of
 * stranding them pending with no run and no gate.
 */

const MATERIAL_COLUMNS = ["bankName", "country", "currency", "routing", "accountNumber"] as const;

type Body = {
  bankName?: string | null;
  country?: string | null;
  currency?: string | null;
  routing?: Record<string, string>;
  /** Plaintext on input only — stored envelope-encrypted with a last-four echo. */
  accountNumber?: string;
  expectedUpdatedAt?: string;
  changeReason?: string;
  retirementReason?: string;
};

export const bankAccountCreateBody = z
  .object({
    bankName: z.string().trim().min(1).max(500).describe("Financial institution name."),
    accountNumber: z
      .string()
      .trim()
      .min(4, { error: "accountNumber required" })
      .max(500)
      .describe(
        "Plaintext account number; the service encrypts it and stores only a last-four echo.",
      ),
    country: z.string().max(100).nullable().optional().describe("Optional ISO country code."),
    currency: z
      .string()
      .max(3)
      .nullable()
      .optional()
      .describe("Optional three-letter account currency."),
    // Routing keys vary by bank and region; persisted values are a string-valued JSONB map.
    routing: z
      .record(z.string().max(50), z.string().max(100))
      .optional()
      .describe("Optional bank-specific routing values stored as a string map."),
  })
  .strict();
export const bankAccountPatchBody = z
  .object({
    bankName: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Replacement institution name, or null to clear."),
    country: z
      .string()
      .max(100)
      .nullable()
      .optional()
      .describe("Replacement ISO country code, or null to clear."),
    currency: z
      .string()
      .max(3)
      .nullable()
      .optional()
      .describe("Replacement account currency, or null to clear."),
    routing: z
      .record(z.string().max(50), z.string().max(100))
      .optional()
      .describe("Replacement bank-specific routing values."),
    accountNumber: z
      .string()
      .trim()
      .min(4, { error: "accountNumber required" })
      .max(500)
      .optional()
      .describe("Replacement plaintext account number; the service encrypts it."),
    expectedUpdatedAt: z
      .string()
      .min(1)
      .max(100)
      .describe("Exact current revision from get_party_bank_accounts."),
    changeReason: z
      .string()
      .max(500)
      .optional()
      .describe("Reason for changing these financial details."),
  })
  .strict();
export const bankAccountRetirementBody = z
  .object({
    expectedUpdatedAt: z
      .string()
      .min(1)
      .max(100)
      .describe("Exact current revision from get_party_bank_accounts."),
    retirementReason: z
      .string()
      .trim()
      .min(5)
      .max(500)
      .describe("Reason for retiring these financial details."),
  })
  .strict();

function validateBody(body: Body, creating: boolean): string | null {
  if (body.bankName !== undefined && !body.bankName?.trim()) return "bankName required";
  if (creating && !body.bankName?.trim()) return "bankName required";
  if (body.accountNumber !== undefined || creating) {
    const accountNumber = typeof body.accountNumber === "string" ? body.accountNumber.trim() : "";
    if (accountNumber.length < 4) return "accountNumber required";
  }
  if (body.country && !normalizeCountryCode(body.country))
    return "country must be a valid ISO country code";
  if (body.currency && !/^[A-Za-z]{3}$/.test(body.currency.trim()))
    return "currency must be a 3-letter code";
  if (body.routing !== undefined) {
    if (!body.routing || Array.isArray(body.routing) || typeof body.routing !== "object")
      return "routing must be an object";
    const entries = Object.entries(body.routing);
    if (
      entries.length > 20 ||
      entries.some(
        ([key, value]) => key.length > 50 || typeof value !== "string" || value.length > 100,
      )
    ) {
      return "routing details are too large";
    }
  }
  return null;
}

/** Require the opaque six-digit PostgreSQL revision token on every mutation. */
function canonicalRevision(value: unknown): string | null {
  return isDocumentRevisionToken(value) ? value : null;
}

type BankRouteContext = {
  request: Request;
  authz: Authz;
  params: { id: string };
  body?: unknown;
};

export async function createPartyBankAccount({
  request: req,
  authz: gate,
  params,
  body: input,
}: BankRouteContext): Promise<NextResponse> {
  const { user } = gate;
  const { id: partyId } = params;
  if (!isUuid(partyId)) return NextResponse.json({ error: "bad party id" }, { status: 400 });

  const scopeDenied = await denyOutsidePartyScope(gate, partyId);
  if (scopeDenied) return scopeDenied;

  const body = input as Body;
  // Party bank-account currency is Multi-currency configuration. Turning that
  // switch off must refuse a new write; omitting currency keeps the create
  // path and stored accounts with a null currency.
  if (body.currency !== undefined && !(await isFeatureEnabled(user.orgId, "multiCurrency"))) {
    return notFound("record");
  }
  const validationError = validateBody(body, true);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  const accountNumber = body.accountNumber!.trim();
  const country = normalizeCountryCode(body.country) ?? null;

  // The insert runs under the party lock with the scope rechecked: the
  // unlocked precheck above may have authorized a party a concurrent rehome
  // moves before this commits.
  return withOrgTransaction(user.orgId, async () => {
    const lockedDenied = await denyLockedOutsidePartyScope(db, gate, partyId);
    if (lockedDenied) return lockedDenied;
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into party_bank_accounts
        (org_id, party_id, bank_name, country, currency, routing,
         account_number_encrypted, account_last_four, approval_status, is_active,
         approved_at, approved_by, submitted_by, submitted_at, created_by)
      values (${user.orgId}, ${partyId}, ${body.bankName?.trim() ?? null}, ${country},
              ${body.currency !== undefined ? body.currency?.trim().toUpperCase() || null : null}, ${JSON.stringify(body.routing ?? {})}::jsonb,
              ${encryptAccountNumber(accountNumber, { orgId: user.orgId })}, ${accountNumber.slice(-4)},
              'pending', false, null, null, ${user.id}, now(), ${user.id})
      returning id
    `,
      "objects",
    );
    const accountId = inserted[0]?.id;
    if (!accountId) throw new Error("The bank details were not saved.");
    const routed = await routeSubjectSubmission({
      orgId: user.orgId,
      actorId: user.id,
      subjectKind: BANK_ACCOUNT_SUBJECT_KIND,
      subjectId: accountId,
      event: { kind: "on_create", source: "ui" },
    });
    // Approvals are optional Flows: with no enabled flow listening, the new
    // details apply directly (audited) instead of stranding pending with no
    // run and no gate. A failed dispatch stays pending — its failed run is
    // retryable and must never auto-release.
    if (routed.policy.kind === "ungated") {
      const today = await businessToday(user.orgId);
      {
        const applied = await db.execute(
          sql`
        update party_bank_accounts
           set approval_status = 'approved', approved_at = ${today},
               approved_by = ${user.id}, is_active = true,
               updated_at = now(), updated_by = ${user.id}
         where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
           and approval_status = 'pending' and retired_at is null
         returning id`,
          "objects",
        );
        if (!applied[0]) {
          return NextResponse.json(
            {
              error:
                "these bank details changed while being recorded; reload and review the latest revision",
            },
            { status: 409 },
          );
        }
        await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${user.orgId}, 'party_bank_accounts', ${accountId}, 'approve',
          ${JSON.stringify({
            mode: "ungated",
            outcome: "approved",
            submissionId: routed.submissionId,
            policy: routed.policy,
          })}::jsonb,
          ${user.id}, ${req.headers.get("X-Request-Id")}
        )
      `);
      }
      return NextResponse.json({ id: accountId, approvalStatus: "approved" }, { status: 201 });
    }
    return NextResponse.json({ id: accountId, approvalStatus: "pending" }, { status: 201 });
  });
}

export async function updatePartyBankAccount({
  request: req,
  authz: gate,
  params,
  body: input,
}: BankRouteContext): Promise<NextResponse> {
  const { user } = gate;
  const { id: partyId } = params;

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId") ?? "";
  if (!isUuid(partyId) || !isUuid(accountId)) {
    return NextResponse.json({ error: "bad ids" }, { status: 400 });
  }
  const partyDenied = await denyOutsidePartyScope(gate, partyId);
  if (partyDenied) return partyDenied;
  // Keep the OCC token in PostgreSQL's six-digit wire form. Mapping
  // timestamptz to Date first would discard microseconds before the CAS.
  const body = input as Body;
  // Party bank-account currency is Multi-currency configuration. Turning that
  // switch off must refuse a currency write; omitting currency keeps the
  // stored account.
  if (body.currency !== undefined && !(await isFeatureEnabled(user.orgId, "multiCurrency"))) {
    return notFound("record");
  }
  const validationError = validateBody(body, false);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  const changedFields = MATERIAL_COLUMNS.filter((k) => body[k as keyof Body] !== undefined);
  if (changedFields.length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const reason = body.changeReason?.trim() ?? "";
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json(
      { error: "a change reason between 5 and 500 characters is required" },
      { status: 422 },
    );
  }
  const expectedUpdatedAt = canonicalRevision(body.expectedUpdatedAt);
  // A material edit re-enters approval (below), so it must never mutate the
  // evidence an in-flight payment instruction was approved against: those
  // instructions keep paying exactly what their file generation locked, but a
  // fresh edit here would leave them pointing at unapproved details. Refuse at
  // the mutation boundary — same dependency rule as retirement (DELETE).
  const accountNumber = body.accountNumber?.trim();
  const country = body.country === undefined ? undefined : normalizeCountryCode(body.country);
  // Keep the material reset, stale-gate cancellation, run completion, audit
  // evidence, and replacement flow dispatch in one tenant transaction. The
  // db handle follows this pinned context, so a failure cannot publish only
  // part of the new bank-detail revision.
  return withOrgTransaction(user.orgId, async () => {
    // A stale unlocked preflight must never reveal whether a rehomed party's
    // bank account exists or which revision it has.
    const lockedDenied = await denyLockedOutsidePartyScope(db, gate, partyId);
    if (lockedDenied) return lockedDenied;
    const existing = await db.execute<{ approvalStatus: string; updatedAt: string }>(
      sql`
      select approval_status as "approvalStatus",
             ${documentRevisionSql(sql.raw("updated_at"))} as "updatedAt"
        from party_bank_accounts
       where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
    `,
      "objects",
    );
    if (existing.length === 0) return notFound("record");
    if (!expectedUpdatedAt || expectedUpdatedAt !== existing[0]!.updatedAt) {
      return NextResponse.json(
        {
          error:
            "these bank details changed after you opened them; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    const dependencies = await db.execute<{ inFlightPayment: boolean }>(
      sql`
      select exists (
        select 1
          from payment_instructions instruction
         where instruction.org_id = ${user.orgId}
           and instruction.payee_bank_account_id = ${accountId}
           and instruction.status in ('pending', 'approved', 'generated', 'sent')
      ) as "inFlightPayment"
    `,
      "objects",
    );
    if (dependencies[0]?.inFlightPayment) {
      return NextResponse.json(
        {
          error:
            "cancel in-flight payment instructions referencing these bank details before editing them",
        },
        { status: 422 },
      );
    }
    // Any material edit re-enters approval: pending + inactive + approval
    // cleared, compared against the stored row before the update.
    const updated = await db.execute<{ id: string }>(
      sql`
      update party_bank_accounts set
        bank_name = ${body.bankName !== undefined ? body.bankName?.trim() || null : sql`bank_name`},
        country = ${body.country !== undefined ? country : sql`country`},
        currency = ${body.currency !== undefined ? body.currency?.trim().toUpperCase() || null : sql`currency`},
        routing = ${body.routing !== undefined ? sql`${JSON.stringify(body.routing)}::jsonb` : sql`routing`},
        account_number_encrypted = ${accountNumber ? encryptAccountNumber(accountNumber, { orgId: user.orgId }) : sql`account_number_encrypted`},
        account_last_four = ${accountNumber ? accountNumber.slice(-4) : sql`account_last_four`},
        approval_status = 'pending', is_active = false, approved_at = null, approved_by = null,
        submitted_by = ${user.id}, submitted_at = now(),
        updated_at = now(), updated_by = ${user.id}
      where id = ${accountId}
        and party_id = ${partyId}
        and org_id = ${user.orgId}
        and updated_at = ${expectedUpdatedAt}::timestamptz
        and retired_at is null
      returning id
    `,
      "objects",
    );
    if (!updated[0]) {
      return NextResponse.json(
        {
          error:
            "these bank details changed or were retired; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    const cancelledRuns = await db.execute<{ run_id: string }>(
      sql`
      update flow_gates
         set status = 'cancelled', updated_at = now()
       where org_id = ${user.orgId}
         and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
         and subject_id = ${accountId}
         and status in ('pending', 'escalated')
       returning run_id
    `,
      "objects",
    );
    const runIds = [...new Set(cancelledRuns.map((row) => row.run_id))];
    if (runIds.length > 0) {
      await db.execute(sql`
        update flow_runs
           set status = 'completed',
               error = null,
               finished_at = now()
         where id = any(${`{${runIds.join(",")}}`}::uuid[])
           and org_id = ${user.orgId}
           and status = 'waiting'
      `);
    }
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
        ${JSON.stringify({
          mode: "bank_detail_material_change",
          reason,
          changedFields,
          approvalStatus: "pending",
        })}::jsonb,
        ${user.id}, 'ui'
      )
    `);

    const routed = await routeSubjectSubmission({
      orgId: user.orgId,
      actorId: user.id,
      subjectKind: BANK_ACCOUNT_SUBJECT_KIND,
      subjectId: accountId,
      event: { kind: "on_update", source: "ui", changedFields },
    });
    if (routed.policy.kind === "ungated") {
      const today = await businessToday(user.orgId);
      const applied = await db.execute(
        sql`
        update party_bank_accounts
           set approval_status = 'approved', approved_at = ${today},
               approved_by = ${user.id}, is_active = true,
               updated_at = now(), updated_by = ${user.id}
         where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
         and approval_status='pending' and retired_at is null returning id
      `,
        "objects",
      );
      if (applied.length !== 1) throw new Error("The bank details changed before release.");
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
          ${JSON.stringify({
            mode: "ungated",
            outcome: "approved",
            changedFields,
            submissionId: routed.submissionId,
            policy: routed.policy,
          })}::jsonb,
          ${user.id}, ${req.headers.get("X-Request-Id")}
        )
      `);
      return NextResponse.json({ id: accountId, approvalStatus: "approved", changedFields });
    }
    return NextResponse.json({ id: accountId, approvalStatus: "pending", changedFields });
  });
}

export async function retirePartyBankAccount({
  request: req,
  authz: gate,
  params,
  body: input,
}: BankRouteContext): Promise<NextResponse> {
  const { user } = gate;
  const { id: partyId } = params;
  const accountId = new URL(req.url).searchParams.get("accountId") ?? "";
  if (!isUuid(partyId) || !isUuid(accountId)) {
    return NextResponse.json({ error: "bad ids" }, { status: 400 });
  }
  const partyDenied = await denyOutsidePartyScope(gate, partyId);
  if (partyDenied) return partyDenied;
  const body = input as Body;
  const reason = body.retirementReason?.trim() ?? "";
  if (reason.length < 5) {
    return NextResponse.json(
      { error: "give a retirement reason of at least five characters" },
      { status: 422 },
    );
  }
  if (!body.expectedUpdatedAt) {
    return NextResponse.json(
      { error: "the bank-detail revision is required; reload and try again" },
      { status: 409 },
    );
  }
  const expectedUpdatedAt = canonicalRevision(body.expectedUpdatedAt);
  if (!expectedUpdatedAt) {
    return NextResponse.json(
      {
        error:
          "these bank details changed or were already retired; reload and review the latest revision",
      },
      { status: 409 },
    );
  }
  // Retirement and its fraud evidence are one commit unit; an audit failure
  // must leave the bank details available for a safe retry.
  return withOrgTransaction(user.orgId, async () => {
    const lockedDenied = await denyLockedOutsidePartyScope(db, gate, partyId);
    if (lockedDenied) return lockedDenied;
    const dependencies = await db.execute<{ in_flight_payment: boolean; live_mandate: boolean }>(
      sql`
      select
        exists (
          select 1
            from payment_instructions instruction
           where instruction.org_id = ${user.orgId}
             and instruction.payee_bank_account_id = ${accountId}
             and instruction.status in ('pending', 'approved', 'generated', 'sent')
        ) as in_flight_payment,
        exists (
          select 1
            from payment_mandates mandate
           where mandate.org_id = ${user.orgId}
             and mandate.party_bank_account_id = ${accountId}
             and mandate.status in ('pending', 'active', 'suspended')
        ) as live_mandate
    `,
      "objects",
    );
    if (dependencies[0]?.in_flight_payment || dependencies[0]?.live_mandate) {
      return NextResponse.json(
        {
          error:
            "cancel in-flight payment instructions and revoke live mandates before retiring these bank details",
        },
        { status: 422 },
      );
    }
    // Bind the caller's canonical six-digit token as timestamptz; a Date or
    // millisecond JSON round-trip would spuriously miss a microsecond row.
    const updated = await db.execute<{ id: string }>(
      sql`
      update party_bank_accounts
         set is_active = false,
             retired_at = now(),
             retired_by = ${user.id},
             retirement_reason = ${reason},
             updated_at = now(),
             updated_by = ${user.id}
       where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
         and retired_at is null
         and updated_at = ${expectedUpdatedAt}::timestamptz
       returning id
    `,
      "objects",
    );
    if (!updated[0]) {
      return NextResponse.json(
        {
          error:
            "these bank details changed or were already retired; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
        ${JSON.stringify({ mode: "bank_detail_retired", reason })}::jsonb,
        ${user.id}, 'ui'
      )
    `);
    return NextResponse.json({ ok: true });
  });
}

class BankAccountSubmitError extends Error {}

export async function submitPartyBankAccount({
  request: req,
  authz: gate,
  params,
}: BankRouteContext): Promise<NextResponse> {
  const { user } = gate;
  const { id: partyId } = params;

  const accountId = new URL(req.url).searchParams.get("accountId") ?? "";
  if (!isUuid(partyId) || !isUuid(accountId)) {
    return NextResponse.json({ error: "bad ids" }, { status: 400 });
  }
  const partyDenied = await denyOutsidePartyScope(gate, partyId);
  if (partyDenied) return partyDenied;

  // Lock the row through dispatch: two simultaneous submits serialize here,
  // and the loser sees the winner's live gate and refuses instead of
  // double-driving the flow.
  return withOrgTransaction(user.orgId, async () => {
    const lockedDenied = await denyLockedOutsidePartyScope(db, gate, partyId);
    if (lockedDenied) return lockedDenied;
    const existing = await db.execute<{
      approvalStatus: string;
      retiredAt: string | null;
    }>(
      sql`
      select approval_status as "approvalStatus", retired_at as "retiredAt"
        from party_bank_accounts
       where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
       for update
    `,
      "objects",
    );
    if (existing.length === 0) return notFound("record");
    const account = existing[0]!;
    if (account.retiredAt) {
      return NextResponse.json(
        { error: "retired bank details cannot be submitted for approval" },
        { status: 422 },
      );
    }
    if (account.approvalStatus !== "pending") {
      return NextResponse.json(
        {
          error: "only bank details awaiting approval can be submitted for approval",
        },
        { status: 422 },
      );
    }
    // Live gates own the record — deciding happens in the approvals centre.
    const live = await db.execute<{ id: string }>(
      sql`
      select id from flow_gates
       where org_id = ${user.orgId}
         and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
         and subject_id = ${accountId}
         and status in ('pending', 'escalated')
       limit 1
    `,
      "objects",
    );
    if (live[0]) {
      return NextResponse.json(
        {
          error:
            "these bank details are already awaiting approval — decide them in the approvals centre",
        },
        { status: 409 },
      );
    }
    const latest = (
      await db.execute<{ id: string; status: string }>(
        sql`
      select id, status from flow_runs
       where org_id = ${user.orgId}
         and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
         and subject_id = ${accountId}
       order by started_at desc
       limit 1
    `,
        "objects",
      )
    )[0];
    // A submit only (re-)drives a record whose runs are all terminal. A
    // failed latest run belongs to the retry path (same run row, resumed
    // idempotently); a running/waiting run is already driving the record.
    if (latest && latest.status !== "completed" && latest.status !== "cancelled") {
      if (latest.status === "failed") {
        return NextResponse.json(
          {
            error: "these bank details have a failed approval run — retry that run instead",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          error: "an approval run is already in flight for these bank details",
        },
        { status: 409 },
      );
    }

    const routed = await routeSubjectSubmission({
      orgId: user.orgId,
      actorId: user.id,
      subjectKind: BANK_ACCOUNT_SUBJECT_KIND,
      subjectId: accountId,
      event: { kind: "on_create", source: "ui" },
    });
    const flows = routed.dispatch;
    // Approvals are optional Flows: with no enabled flow listening, an
    // explicit submit applies the details directly (audited) instead of
    // refusing and leaving the row pending with no run and no gate. This is
    // also the recovery for records stranded pending before any flow
    // existed: the operator submits, and with nothing to govern them the
    // details activate.
    if (routed.policy.kind === "ungated") {
      const today = await businessToday(user.orgId);
      const applied = await db.execute(
        sql`
        update party_bank_accounts
           set approval_status = 'approved', approved_at = ${today},
               approved_by = ${user.id}, is_active = true,
               updated_at = now(), updated_by = ${user.id}
         where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
           and approval_status = 'pending' and retired_at is null
         returning id`,
        "objects",
      );
      if (!applied[0]) {
        throw new BankAccountSubmitError(
          "these bank details changed while submitting — reload and submit again",
        );
      }
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${user.orgId}, 'party_bank_accounts', ${accountId}, 'approve',
          ${JSON.stringify({
            mode: "ungated",
            outcome: "approved",
            submissionId: routed.submissionId,
            policy: routed.policy,
          })}::jsonb,
          ${user.id}, ${req.headers.get("X-Request-Id")}
        )
      `);
      return NextResponse.json({
        id: accountId,
        approvalStatus: "approved",
        directApplied: true,
      });
    }
    const runId = flows.runs[0]?.runId ?? null;
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
        ${JSON.stringify({
          mode: "bank_detail_submitted_to_flow",
          runId,
          gatesCreated: flows.gatesCreated,
        })}::jsonb,
        ${user.id}, 'ui'
      )
    `);
    return NextResponse.json({
      id: accountId,
      approvalStatus: "pending",
      runId,
      gatesCreated: flows.gatesCreated,
    });
  }).catch((e) => {
    if (e instanceof BankAccountSubmitError) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
    throw e;
  });
}
